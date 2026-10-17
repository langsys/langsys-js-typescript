import { LangsysAppAPI, LangsysConfigurationError } from './api.js';
import { canonicalizeLocale, maximizedLangScript } from './locale.js';
import { Logger, logger } from './logger.js';
import { autoDiscovery, batchLimit, catalogScopeOf, config as configStore, configured, currentlyLoadedLocale, discoveryBaseLocaleOnly, pageCatalog, pageLocale, scopeCatalogCache, sTranslations } from './stores.js';
import { DEFAULT_SERVER_MESSAGE_CATEGORY, fillTemplate, type ServerMessage } from './server-messages.js';
import { parseSnapshot, type CatalogSnapshot } from './snapshot.js';
import { rememberSeededBlock, rememberSeededPhrase } from './served-source.js';
import { settleNotices } from './notices.js';
import { activeScope } from './scope-context.js';
import type { SeededBlock, SeededPhrase } from './block-tree.js';
import { failureWindowMs, noticeUnusableWriteCapability, Translations } from './translations.js';
import type { ResponseObject } from './types/api.js';
import type { iLangsysConfig, iLangsysInitConfig, WriteGrant } from './types/config.js';
import type { iCountryDialCode, iCountryList } from './types/countries.js';
import type { iCurrencyList } from './types/currencies.js';
import type { iLocaleData, iLocaleDefault, iLocaleFlat } from './types/locales.js';
import type { TFunction } from './types/translation-fn.js';
import type { iCategories, iTranslations } from './types/translations.js';
import { structuredCloneShim } from './utils.js';

/** One reference list in one display locale: the list held, the read in flight, or the last failures. */
interface ReferenceListEntry {
    list?: unknown;
    reading?: Promise<unknown>;
    failures?: number;
    retryAt?: number;
}

class LangsysAppClass {
    private config: iLangsysConfig;

    public Translations: Translations;
    public translationsLoadingPromise: Promise<unknown> = Promise.resolve();

    /**
     * The reference lists read so far (REF-1), keyed by list and display locale: a list the API
     * answered is held for the core's lifetime, a read in flight is shared, and a failed read is
     * remembered for CACHE-2's window. Memory only: on a server the core is the long-lived
     * module, so the hold already outlives the request, and nothing goes to a cache another
     * host reads (CACHE-1).
     */
    private referenceLists = new Map<string, ReferenceListEntry>();

    public debug: Logger;

    constructor() {
        this.config = configStore;
        this.debug = new Logger(!!this.config.debug);
        this.Translations = new Translations(this.config);
    }

    /** Current translation function. Reads fresh state on every call. */
    public get t(): TFunction {
        return this.Translations.t;
    }

    /**
     * Supply (or replace) the write grant after `init()` has run.
     *
     * This is for apps whose token only exists once the user logs in — i.e.
     * after the SDK has already booted. It is NOT the refresh path: the token
     * is resolved fresh before every request and never cached, so refresh is a
     * pull. Pass a provider function and let your auth layer decide when to
     * mint; that also makes this safe to call while a request is in flight,
     * since an in-flight request has already resolved its own token.
     *
     * Pass `undefined` to drop the grant (e.g. on logout).
     */
    public async setWriteGrant(grant: WriteGrant | undefined): Promise<void> {
        this.config.writeGrant = grant;
        configStore.writeGrant = grant;
        this.debug.log('Write grant', grant ? 'set' : 'cleared');

        // Setting config is not enough: write capability is computed by the
        // SERVER, and it has had no opportunity to re-evaluate this session
        // with (or without) the new `X-Write-Grant` header. Without this
        // re-authorization `writeEnabled` keeps whatever the original auth
        // returned — so a grant supplied after login would never take effect
        // on a stable locale, because nothing else re-derives it.
        if (!this.config.projectid || !this.config.key) return;
        const response = await LangsysAppAPI.validate(this.config);
        if (response.status && response.data) this.applyAuthorization(response.data, 'grant change');
    }

    /**
     * Apply an `authorize-project` payload. Shared by `init` and the
     * re-authorization in `setWriteGrant`, so a policy or capability change is
     * picked up identically by both — previously the re-auth path silently
     * ignored `auto_discovery` even though the response carries it.
     */
    private applyAuthorization(data: object, context: string): void {
        const authData = data as {
            key_type?: string;
            write_enabled?: boolean;
            auto_discovery?: boolean;
            discovery_base_locale_only?: boolean;
            langsys_settings?: { translatable_items?: { batch_limit?: number } };
        };

        if (authData.key_type) {
            this.config.key_type = authData.key_type;
            configStore.key_type = authData.key_type;
            // Display/debug only — every write decision goes through
            // `writeEnabled`. `key_type` cannot express `ip_write`.
            this.debug.log('API Key Type:', authData.key_type);
        }

        // ONE condition drives both the write fallback and the report lane.
        // A server with no `write_enabled` predates the capability, which means
        // it also has no `/discovery/hint` to receive a report — so reading
        // those two facts from separate signals lets them diverge, and the
        // divergent state (reporting to an endpoint that does not exist) is
        // silent by construction. Relying on `auto_discovery` also being absent
        // would work today and only by coincidence.
        const serverSpeaksCapability = typeof authData.write_enabled === 'boolean';

        if (serverSpeaksCapability) {
            this.Translations.applyWriteEnabled(authData.write_enabled as boolean, authData.key_type);
            this.debug.log(`Session write-enabled (${context}):`, authData.write_enabled);
            noticeUnusableWriteCapability(authData.write_enabled as boolean, authData.key_type);
        } else {
            // An ABSENT field is not `false`. It means the server predates
            // `write_enabled`, and treating absence as a refusal would leave
            // the SDK write-inert against every deployment that hasn't shipped
            // the flag yet — silently, for every consumer, until the API
            // catches up. That turns a release-ordering mistake into a dead
            // integration, so fall back to the old inference for exactly this
            // case. It is sound because `ip_write` cannot exist on a backend
            // that doesn't return the flag, so `key_type` still describes the
            // whole truth there.
            const legacy = authData.key_type === 'write';
            this.debug.warn(
                `Server did not return write_enabled (${context}) — falling back to key_type ` +
                    `'${authData.key_type ?? 'unknown'}' => ${legacy}. Upgrade the API for IP-gated and grant-based writes.`
            );
            this.Translations.applyWriteEnabled(legacy, authData.key_type);
        }

        // Project policy: register and hint only while rendering the base locale. Read
        // here as well as on every catalog fetch, because a read-only session may never
        // fetch a catalog and would otherwise never learn the setting. Absent means off,
        // and no client config can override it — the handshake is the one source of truth.
        if (typeof authData.discovery_base_locale_only === 'boolean') {
            discoveryBaseLocaleOnly.set(authData.discovery_base_locale_only);
            this.debug.log(`Discovery limited to the base locale (${context}):`, authData.discovery_base_locale_only);
        }

        // Server-authoritative batch cap. Honour it rather than assuming ours.
        const limit = authData.langsys_settings?.translatable_items?.batch_limit;
        if (typeof limit === 'number' && limit > 0) {
            batchLimit.set(limit);
            this.debug.log(`Batch limit (${context}):`, limit);
        }

        if (!serverSpeaksCapability) {
            // Same condition, deliberately not a second derivation. Whatever the
            // legacy server said about policy is moot — there is nowhere to
            // report to. Note this is the one place the two are coupled: while
            // the server DOES speak the capability, policy remains strictly
            // independent of it (see `autoDiscovery`), and the canonical public
            // site is write-disabled AND reporting-permitted.
            autoDiscovery.set(false);
            this.debug.log(`Discovery reporting disabled (${context}): server predates the capability`);
        } else if (typeof authData.auto_discovery === 'boolean') {
            autoDiscovery.set(authData.auto_discovery);
            this.debug.log(`Discovery reporting permitted (${context}):`, authData.auto_discovery);
        }
    }

    /** A route change re-enters the SDK (HINT-13). See `Translations.notifyNavigation`. */
    public notifyNavigation(): void {
        this.Translations.notifyNavigation();
    }

    /**
     * Put a catalog in place SYNCHRONOUSLY, with no network and no await.
     *
     * The hydration hand-off primitive: a framework's client entry calls this
     * with the catalog the server already rendered from, before mount, so the
     * first paint has translations instead of source text. `t()` returns the
     * translation on the very next line — there is nothing to await, which is
     * the whole point. `init()` can run afterwards, at its own pace, to
     * authorize and take over refreshes.
     *
     * Does exactly what the `initialTranslations` hand-off inside `init()` does
     * — injects `__uncategorized__`, stamps every `__category__`, publishes the
     * catalog and the locale — because it IS that code now. Two
     * implementations of "seed a catalog" would be two sets of rules about what
     * a seeded catalog looks like.
     *
     * Safe to call before `init()`, after it, or both: `init()` will not
     * re-seed a locale that is already seeded, so an SSR payload passed through
     * config cannot clobber a catalog a client entry put there first.
     *
     * `served`, a request scope's `seed()`, hands over what the server rendered
     * before any DOM class mounts: each block's source tokens, which a served
     * translation re-renders from, and which blocks and phrases the server sends
     * itself (`collected`), which the client then never registers. Nothing is
     * registered here; `registerBlock(seededBlock)` after `init()` does that.
     */
    /**
     * The request header that asks the app's own API for the user's language
     * (FRM-6): `{ 'Accept-Language': 'es-es' }` for the locale the user chose,
     * inside a request scope the scope's, else the loaded catalog's. Empty before
     * any locale is known. Spread it into the headers of the app's API calls, so an
     * API that answers per the negotiated language (FRM-5) answers in the user's,
     * not the browser's default.
     */
    public localeHeaders(): Record<string, string> {
        const locale = activeScope()?.locale || this.config?.sUserLocale?.get?.() || currentlyLoadedLocale.get();
        return locale ? { 'Accept-Language': canonicalizeLocale(locale) } : {};
    }

    public seedCatalog(
        catalog: iCategories,
        locale: string,
        served?: { blocks?: Record<string, SeededBlock>; phrases?: readonly SeededPhrase[] }
    ): void {
        for (const block of Object.values(served?.blocks ?? {})) rememberSeededBlock(block);
        for (const phrase of served?.phrases ?? []) rememberSeededPhrase(phrase);
        this.publishSeed(catalog, locale);
        // So a later `change()` for this locale is a cache hit rather than a
        // fetch that overwrites what the server already sent, and so
        // `ready()` resolves for consumers that await it before `init`.
        this.Translations.markLoaded(canonicalizeLocale(locale));
        this.debug.log('Seeded catalog for locale', canonicalizeLocale(locale));
    }

    /**
     * Load a catalog snapshot (spec SNAP-2) SYNCHRONOUSLY as the preloaded
     * catalog for `locale` — the current user locale by default, else the
     * snapshot's base locale. A first render or an offline session then has
     * its translations with no network call.
     *
     * The snapshot is a cache, never the catalog of record (SNAP-3): once
     * `init()` runs, the catalog is fetched as usual and replaces it, and a
     * phrase the snapshot lacks is found there. With no network the snapshot
     * keeps rendering, and anything it lacks shows its source text.
     *
     * Throws `SnapshotError`, naming the reason, for a file that is not a
     * snapshot, an unsupported version, a missing member, or a checksum the
     * contents no longer match — an edited snapshot is refused, not served.
     * Returns false when the snapshot holds no catalog for the locale.
     */
    public loadSnapshot(snapshot: string | CatalogSnapshot, locale?: string): boolean {
        const parsed = parseSnapshot(snapshot);
        const wanted = canonicalizeLocale(locale || this.config.sUserLocale?.get?.() || parsed.base_locale);
        const catalog = parsed.catalog[wanted];
        if (!catalog) return false;
        this.publishSeed(JSON.parse(JSON.stringify(catalog)) as iCategories, wanted);
        this.Translations.markSeeded();
        this.debug.log('Loaded snapshot catalog for locale', wanted);
        return true;
    }

    /** Publish a catalog and its locale — the one set of rules for what a seeded catalog looks like. */
    private publishSeed(catalog: iCategories, locale: string): void {
        const normalizedLocale = canonicalizeLocale(locale);

        if (!catalog['__uncategorized__']) {
            catalog['__uncategorized__'] = {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
            } as iTranslations;
        }
        for (const cat of Object.keys(catalog)) {
            catalog[cat]['__category__'] = cat;
        }

        sTranslations.set(catalog);
        currentlyLoadedLocale.set(normalizedLocale);
    }

    /**
     * Render a server message entry (spec MSG-5): its `template` through `t()`
     * under the messages category, filled from its `params`. When the catalog
     * holds no translation for the template, the entry's own `message` is shown
     * instead, which is the text the server filled and possibly localised; an
     * entry with no `message` shows its template filled. An entry with no
     * `template` is not looked up and shows its `message`. `message` is never
     * used as a lookup key.
     *
     * The lookup goes through `t()` on a miss too, so the template is recorded
     * like any other missing phrase. A plural in the translation renders from a
     * numeric param through the catalog's ICU, with no ICU written by the caller.
     */
    public renderServerMessage(entry: ServerMessage, category?: string): string {
        if (typeof entry.template !== 'string') return entry.message ?? '';
        const messagesCategory = category || this.config.messagesCategory || DEFAULT_SERVER_MESSAGE_CATEGORY;
        const params = entry.params ?? {};
        const translated = this.Translations.lookup(entry.template, messagesCategory) !== null;
        const t = this.Translations.tSignal.get() as unknown as (
            phrase: string,
            category: string,
            params: Record<string, unknown>
        ) => string;
        const rendered = t(entry.template, messagesCategory, params);
        if (translated) return rendered;
        return entry.message ?? fillTemplate(entry.template, params);
    }

    /** Whether a catalog is already published for this locale. */
    private isAlreadySeeded(locale: string): boolean {
        if (pageLocale() !== canonicalizeLocale(locale)) return false;
        const current = pageCatalog();
        // The empty skeleton is not a seeded catalog — it is the initial value.
        return Object.keys(current).some((cat) => cat !== '__uncategorized__' || Object.keys(current[cat]!).length > 2);
    }

    /** Read the current locale's catalog again, and the locale data `getLocaleName` reads, on its next load. */
    public async refresh() {
        const locale = this.config.sUserLocale.get();
        for (const key of [...this.referenceLists.keys()]) if (key.startsWith('locales/data\0')) this.forgetReferenceList(key);
        return this.Translations.change(locale, true);
    }

    /**
     * Initialize Langsys. Configuration must include at least `projectid`,
     * `key`, and `UserLocaleStore` (anything satisfying `LocaleSource` — see
     * its docstring for framework-specific adapters).
     */
    /**
     * Whether `init()` accepted a project id, an API key and a locale store (WIRE-4). False
     * before `init()` runs and after one refused for missing credentials. Authorization is a
     * separate question: a configured client whose key the server refuses is still configured.
     */
    public isConfigured(): boolean {
        return configured.get() === true;
    }

    /**
     * `init()` without credentials (WIRE-4). Nothing throws here: `t()` renders source text with
     * its params filled, no miss is queued and no request is made, a component's block
     * registration resolves skipped with reason `not-configured`, and an explicit write throws
     * `LangsysConfigurationError`. With `requireCredentials`, `t()` throws it too.
     */
    private refuseUnconfigured(missing: string, errorText: string, requireCredentials: boolean): ResponseObject {
        configured.set(false);
        LangsysAppAPI.clearCredentials();
        // Forgotten on every copy, so nothing an earlier init() set up (a grant change, its
        // locale store's next emission) can hand the old key back to the client.
        const forgotten = { projectid: '', key: '', writeGrant: undefined };
        Object.assign(configStore, forgotten);
        Object.assign(this.config, forgotten);
        this.Translations.markUnconfigured(
            new LangsysConfigurationError(`Langsys is not configured: LangsysApp.init() was called without ${missing}.`),
            requireCredentials
        );
        return { status: false, errors: [errorText] };
    }

    public async init(initConfig: iLangsysInitConfig): Promise<ResponseObject> {
        const projectid = initConfig.projectid;
        const key = initConfig.key;
        const UserLocaleStore = initConfig.UserLocaleStore;
        let baseLocale = initConfig.baseLocale || 'en';
        const debug = initConfig.debug || false;
        const emulateFailureToLoad = initConfig.emulateFailureToLoad || false;
        const ssrTokenStrategy = initConfig.ssrTokenStrategy || 'client';
        const initialTranslations = initConfig.initialTranslations;
        const initialTranslationsLocale = initConfig.initialTranslationsLocale;
        const writeGrant = initConfig.writeGrant;
        const requireCredentials = initConfig.requireCredentials === true;

        this.debug.debugEnabled = debug;

        // The module-scope `logger` singleton is a SEPARATE instance from the
        // per-class `this.debug` loggers, and nothing else ever writes its flag
        // — so anything gated on `logger.debugEnabled` was permanently off.
        // That silently disabled `warnUnmatchedParams` (unmatched `params` keys
        // in `<Translate>`/`<Phrase>`) for every consumer: the feature shipped,
        // typechecked, had tests, and could never fire. `init` is the one place
        // `debug` is resolved, so it is the right place to propagate it.
        logger.debugEnabled = debug;
        // Debug notices raised before this point were held until debug was known.
        settleNotices();

        // What a request scope with credentials of its own needs from init() holds whether or
        // not init() has credentials (SRV-2): the API host, set before validate() since
        // authorizing against the default host and then switching is silent, and the strategy.
        if (initConfig.apiUrl) LangsysAppAPI.setBaseUrl(initConfig.apiUrl);
        configStore.ssrTokenStrategy = ssrTokenStrategy;

        if (debug && initialTranslations) {
            this.debug.log('SSR initial translations config:', {
                hasInitialTranslations: !!initialTranslations,
                initialTranslationsLocale,
                categoriesProvided: initialTranslations ? Object.keys(initialTranslations).length : 0,
                categories: initialTranslations ? Object.keys(initialTranslations) : [],
            });
        }

        // Every early return below leaves the client unconfigured (WIRE-4) and settles the
        // ready() gate. No catalog is coming on these paths, and `Phrase`/`Translate` await
        // that gate before rendering — so leaving it pending renders nothing, forever, with
        // no error, on the commonest misconfigurations there are.
        if (!projectid) {
            this.debug.error('LangsysApp.init missing projectid in configuration object!');
            return this.refuseUnconfigured('a project id', 'Missing projectid', requireCredentials);
        }
        if (!key) {
            this.debug.error('LangsysApp.init missing API key in configuration object!');
            return this.refuseUnconfigured('an API key', 'Missing API key', requireCredentials);
        }
        if (!UserLocaleStore?.subscribe || typeof UserLocaleStore.get !== 'function') {
            this.debug.error(
                "LangsysApp.init missing UserLocaleStore — pass any object satisfying LocaleSource (get + subscribe). createSignal('en-US') works if you have nothing of your own."
            );
            return this.refuseUnconfigured('a locale store', 'Missing UserLocaleStore', requireCredentials);
        }
        configured.set(true);
        this.Translations.markConfigured();

        // Lowercase `xx-yy` (`en-us`, `zh-hant-tw`) — the form the backend
        // stores and every internal cache key uses as the identity.
        baseLocale = canonicalizeLocale(baseLocale);

        // The legacy-key mode is on only when configured, and a file this core
        // cannot read throws here, before anything resolves through it (MIG-1, MIG-7).
        this.Translations.setLegacyKeys(initConfig.legacyKeys);

        if (!emulateFailureToLoad) {
            this.config = {
                projectid,
                key,
                sUserLocale: UserLocaleStore,
                baseLocale,
                debug,
                ssrTokenStrategy,
                writeGrant,
                messagesCategory: initConfig.messagesCategory || DEFAULT_SERVER_MESSAGE_CATEGORY,
            };
            // Keep the exported config singleton in sync (used by Translate + API).
            Object.assign(configStore, this.config);

            // Restore this project and locale's cached catalog now, while authorization is
            // in flight, so `t()` renders it during the round trip instead of source text:
            // both halves of the cache key are known here (CACHE-1). The cache holds the
            // catalog and never the write decision (GATE-4), registration still decides
            // only against the live catalog (REG-13), and a refused authorization leaves
            // the restored catalog rendering, as a preloaded snapshot does (CACHE-2). The loaded
            // locale is not set: it names a catalog this session fetched or was handed,
            // and that is what lets `initialTranslations` below replace a stale copy.
            const startLocale = canonicalizeLocale(UserLocaleStore.get() || '');
            if (startLocale) scopeCatalogCache(catalogScopeOf(projectid, startLocale));
        }

        // A grant makes write capability per-user, while the SSR write lane can
        // only hold a process-wide decision — so it would apply one user's
        // capability to every later visitor in that Node process. Degrading to
        // the client lane is correct, but silent degradation costs someone an
        // afternoon, so say it out loud.
        if (writeGrant && ssrTokenStrategy !== 'client') {
            this.debug.warn(
                `ssrTokenStrategy '${ssrTokenStrategy}' degrades to 'client' while a writeGrant is configured — ` +
                    'write capability is per-user with a grant, so a server-side decision would leak across ' +
                    'requests. Tokens will flush after hydration instead.'
            );
        }

        const validateResponse = await LangsysAppAPI.validate(this.config);

        if (validateResponse.status && validateResponse.data) {
            // On this route `data` is not a catalog, so `write_enabled` is a
            // safe sibling of `key_type` inside it (unlike `/translations`,
            // where `data` IS the category map and it must be envelope-level).
            this.applyAuthorization(validateResponse.data, 'init');
        } else {
            // Authorization failed — bad key, wrong host, unreachable server.
            // The locale subscription installed below short-circuits on
            // `!validateResponse.status`, so no catalog will ever load and
            // nothing else would resolve the gate. Nor would anything answer the
            // capability, so it settles as not writable: a block registration
            // waiting on it resolves skipped instead of waiting forever.
            this.Translations.settleNotWritable();
            this.Translations.settle();
        }

        // Seed the translations store if initial data is provided (SSR handoff).
        // Same primitive a client entry can call directly before init — see
        // `seedCatalog`. `init` does NOT re-seed a catalog already seeded for
        // this locale, so calling both is safe and order-independent.
        if (initialTranslations && initialTranslationsLocale) {
            if (!this.isAlreadySeeded(initialTranslationsLocale)) {
                this.seedCatalog(initialTranslations, initialTranslationsLocale);
            } else {
                this.debug.log('Catalog already seeded for locale; leaving it', initialTranslationsLocale);
            }
        }

        this.Translations.setup(this.config);

        // The SSR handoff already populated the stores for this locale, so prime
        // the fetch cache (after setup, which would otherwise reset this.locale).
        // The first settle for this locale is then a cache hit — no redundant
        // fetch — while switching *back* to it later still flows through
        // change() and rebuilds the t-signal. (Do NOT gate change() on a
        // "skip fetch" flag here: it would otherwise stay armed and silently
        // skip every return to the initial locale.)
        if (initialTranslations && initialTranslationsLocale) {
            this.Translations.markLoaded(initialTranslationsLocale);
        }

        // Prefetch and wire up reactive locale change handling. The store
        // emits whatever the app put in it — canonicalize here so downstream
        // caches and API routes only ever see the lowercase `xx-yy` form.
        this.config.sUserLocale.subscribe((rawLocale) => {
            if (!validateResponse.status) return;
            const locale = canonicalizeLocale(rawLocale);
            // A prefetch for getLocaleName, not the app's first use: a refused re-init under
            // requireCredentials makes the read reject, and nothing here is waiting to hear it.
            this.getLocalesData(rawLocale).catch(() => {});
            this.debug.log('SUBSCRIBING TO USER LOCALE STORE');
            this.translationsLoadingPromise = this.Translations.change(locale, false);
        });

        return validateResponse;
    }

    /** The countries' dial codes, named in the display locale (REF-1). */
    public async getDialCodes(inLocale?: string): Promise<iCountryDialCode[]> {
        return this.readReferenceList('getDialCodes', 'countries/dial-codes', inLocale, () => []);
    }

    /** The currencies, named in the display locale (REF-1). */
    public async getCurrencies(inLocale?: string): Promise<iCurrencyList> {
        return this.readReferenceList('getCurrencies', 'currencies', inLocale, () => []);
    }

    /** The countries, named in the display locale (REF-1). */
    public async getCountries(inLocale?: string): Promise<iCountryList> {
        return this.readReferenceList('getCountries', 'countries', inLocale, () => []);
    }

    public async getCountryName(forCountryCode: string, inLocale?: string): Promise<string> {
        if (!forCountryCode) return '';
        const countries = await this.getCountries(inLocale);
        const country = countries.find((c) => c.code?.toLowerCase() === forCountryCode.toLowerCase())?.label;
        if (!country) this.debug.warn('getCountryName failed to match', forCountryCode);
        return country || forCountryCode;
    }

    public async getCurrencyName(forCurrencyCode: string, inLocale?: string): Promise<string> {
        if (!forCurrencyCode) return '';
        const currencies = await this.getCurrencies(inLocale);
        const currency = currencies.find((c) => c.code?.toLowerCase() === forCurrencyCode.toLowerCase())?.name;
        if (!currency) this.debug.warn('getCurrencyName failed to match', forCurrencyCode);
        return currency || forCurrencyCode;
    }

    /** The locales in one of the API's three forms, named in the display locale (REF-1). */
    public async getLocalesFormat(
        format: '' | 'flat' | 'data' = '',
        inLocale?: string
    ): Promise<iLocaleDefault | iLocaleFlat[] | iLocaleData[]> {
        const method = format === 'flat' ? 'getLocalesFlat' : format === 'data' ? 'getLocalesData' : 'getLocales';
        return this.readReferenceList<iLocaleDefault | iLocaleFlat[] | iLocaleData[]>(
            method,
            'locales' + (format ? `/${format}` : ''),
            inLocale,
            () => (format ? [] : {}),
            { grouped: !format }
        );
    }

    public async getLocalesFlat(inLocale?: string): Promise<iLocaleFlat[]> {
        return (await this.getLocalesFormat('flat', inLocale)) as iLocaleFlat[];
    }

    /** `forceRefresh` is an explicit refresh: it reads the list again, held or inside a failure window, and holds what that read answers. */
    public async getLocalesData(inLocale?: string, forceRefresh = false): Promise<iLocaleData[]> {
        if (forceRefresh) this.forgetReferenceList(`locales/data\0${this.displayLocale(inLocale)}`);
        return (await this.getLocalesFormat('data', inLocale)) as iLocaleData[];
    }

    public async getLocales(inLocale?: string): Promise<iLocaleDefault> {
        return (await this.getLocalesFormat('', inLocale)) as iLocaleDefault;
    }

    /**
     * Read one reference list in a display locale (REF-1), or answer the one held for it.
     *
     * The display locale is the one given, else the current one, in WIRE-3's form; one not
     * shaped as a locale is refused before anything is sent, since it is written into the
     * request. A locale form is asked for that locale alone and answers that locale's entry,
     * whose key and codes are in the organisation's code format, so it is matched and recoded
     * in WIRE-3's form; a locale the API does not hold answers `empty()`, held like any
     * answer. Nothing here throws but `requireCredentials` (WIRE-4): a refused locale, a failed
     * read and an answer not of the list's shape answer `empty()` with the cause logged, and
     * a failed read is remembered for CACHE-2's window, inside which the call sends nothing.
     * An unconfigured core sends nothing and logs nothing, whatever the display locale,
     * `init()`'s refusal being its one warning. Each caller gets its own copy of a held list,
     * so what one caller does to it never reaches the next.
     */
    private async readReferenceList<T>(
        method: string,
        route: string,
        inLocale: string | undefined,
        empty: () => T,
        opts: { grouped?: boolean } = {}
    ): Promise<T> {
        // An unconfigured core answers empty and sends nothing (WIRE-4), whatever a configured
        // scope may have held; a scope's own credentials configure it (SRV-2).
        const credentials = LangsysAppAPI.currentCredentials();
        if (!credentials.projectid || !credentials.key) {
            this.Translations.assertConfigured();
            return empty();
        }
        const locale = this.displayLocale(inLocale);
        if (!isLocaleShaped(locale)) {
            this.debug.warn(`LangsysApp.${method}: "${locale}" is not a locale, so no list is read for it.`);
            return empty();
        }
        const key = `${route}\0${locale}`;
        const held = this.referenceLists.get(key);
        if (held && 'list' in held) return structuredCloneShim(held.list) as T;
        if (held?.reading) {
            const shared = await held.reading;
            return (shared === undefined ? empty() : structuredCloneShim(shared)) as T;
        }
        if (held?.retryAt !== undefined && Date.now() < held.retryAt) {
            this.debug.log(`LangsysApp.${method}: the last read of ${route} (${locale}) failed, so none is sent until`, new Date(held.retryAt));
            return empty();
        }

        const byLocale = route.startsWith('locales');
        const reading = (async (): Promise<unknown> => {
            try {
                const response = byLocale
                    ? await LangsysAppAPI.get(route, { 'locales[]': locale, append_target_locales: '0' }, { credentials })
                    : await LangsysAppAPI.get(`${route}/${locale}`, {}, { credentials });
                if (response.errors || !response.status) {
                    this.debug.error(`LangsysApp.${method} failed: ${route} (${locale}):`, response.errors ?? response.http?.status);
                    return undefined;
                }
                const list = byLocale ? localeEntry(response.data, locale, opts.grouped === true, empty) : Array.isArray(response.data) ? response.data : undefined;
                if (list === undefined) {
                    this.debug.error(`LangsysApp.${method}: the answer for ${route} (${locale}) is not of the list's shape.`, response.data);
                    return undefined;
                }
                return byLocale ? withWire3Codes(list) : list;
            } catch (err) {
                this.debug.error(`LangsysApp.${method} failed: ${route} (${locale}):`, err);
                return undefined;
            }
        })();
        this.referenceLists.set(key, { ...held, reading });
        const list = await reading;
        // An explicit refresh may have started another read meanwhile; only this read's own entry changes.
        if (this.referenceLists.get(key)?.reading === reading) {
            if (list !== undefined) this.referenceLists.set(key, { list });
            else {
                const failures = (held?.failures ?? 0) + 1;
                this.referenceLists.set(key, { failures, retryAt: Date.now() + failureWindowMs(failures) });
            }
        }
        return (list === undefined ? empty() : structuredCloneShim(list)) as T;
    }

    /**
     * An explicit refresh of one list and display locale: the held list and any failure window
     * go, so the next call reads. The count of failures in a row stays, so a refresh that fails
     * again widens CACHE-2's window as any failure in a row does.
     */
    private forgetReferenceList(key: string): void {
        const failures = this.referenceLists.get(key)?.failures;
        if (failures) this.referenceLists.set(key, { failures });
        else this.referenceLists.delete(key);
    }

    /**
     * A reference list's display locale (REF-1): the one given, else the current one, inside a
     * request scope the scope's, in WIRE-3's form. That form, `_` read as `-` and lowercased,
     * is the API's own for its locale codes; canonicalising further would resolve aliases and
     * rewrite a code the API holds (`en-us-posix` to `en-us-u-va-posix`).
     */
    private displayLocale(inLocale?: string): string {
        return wire3Locale(inLocale || activeScope()?.locale || this.config?.sUserLocale?.get?.() || this.config?.baseLocale || 'en');
    }

    public async getLocaleNameWithLookup(forLocale: string, shortName = false, inLocale?: string): Promise<string> {
        if (!forLocale) return '';
        const locale = this.displayLocale(inLocale);
        await this.getLocalesData(locale);
        return this.getLocaleName(forLocale, shortName, locale);
    }

    /**
     * Synchronous locale-name lookup against the in-memory locales cache.
     *
     * The cache is only populated once `await getLocalesData(inLocale)` — or
     * any `getLocaleNameWithLookup` call — has settled for that display locale.
     * Called before then this returns `''`, the same value a genuinely unknown
     * locale returns, so the two cases are told apart by the warning rather
     * than by the return value. Use `getLocaleNameWithLookup` when you can
     * await; it loads the data first.
     */
    public getLocaleName(forLocale: string, shortName = false, inLocale?: string): string {
        const locale = this.displayLocale(inLocale);

        // Distinguished from a lookup miss deliberately. Both return '', and
        // the old warning reported both as a failed match — sending developers
        // to check a locale code that was fine, when the real problem was that
        // nothing had been loaded to check it against.
        const data = this.referenceLists.get(`locales/data\0${locale}`)?.list as iLocaleData[] | undefined;
        if (!data) {
            this.debug.warn(
                `getLocaleName('${forLocale}') called before locale data for '${locale}' was loaded — ` +
                    `run \`await getLocalesData('${locale}')\` first, or use \`await getLocaleNameWithLookup(...)\` instead.`
            );
            return '';
        }

        // The codes are in WIRE-3's form; the core's canonical form also names a legacy alias (`iw`).
        const targets = [wire3Locale(forLocale), canonicalizeLocale(forLocale)];
        const entry = data.find((loc) => targets.includes(wire3Locale(loc.code)));
        const name = entry ? (shortName ? entry.lang_name : entry.locale_name) : '';
        if (!name) this.debug.warn('getLocaleName found no entry matching', forLocale);
        return name;
    }

    /** @deprecated use `getLocaleNameWithLookup` or `getLocaleName` */
    public async getLanguageName(forLocale: string, shortName = false, inLocale?: string): Promise<string> {
        return this.getLocaleNameWithLookup(forLocale, shortName, inLocale);
    }

    /**
     * Detects the end-user's preferred locale.
     *
     * - In browsers, uses `navigator.languages` with fallback to `navigator.language`.
     * - In SSR environments, parses the `Accept-Language` header.
     *
     * With `supportedLocales`, returns the best CLDR-aware match from that list
     * or `false` when none of the user's preferences are supported — so the
     * documented `detectPreferredLocale(header, supported) || 'en-us'` idiom
     * actually reaches your default. Returning the user's own unsupported
     * locale instead would send the app to fetch a catalog that does not
     * exist, and the caller's `||` would never fire.
     *
     * Without `supportedLocales`, returns the user's first preference in
     * canonical form, or `false` when no preference is detectable.
     */
    public detectPreferredLocale(
        acceptLanguageHeader?: string | null,
        supportedLocales?: string[]
    ): string | false {
        const userLocales = this.getUserLanguagePreferences(acceptLanguageHeader);
        if (userLocales.length === 0) return false;

        if (supportedLocales && supportedLocales.length > 0) {
            return this.findBestLocaleMatch(userLocales, supportedLocales) ?? false;
        }

        return canonicalizeLocale(userLocales[0]);
    }

    private getUserLanguagePreferences(acceptLanguageHeader?: string | null): string[] {
        if (acceptLanguageHeader) {
            try {
                return this.parseAcceptLanguageHeader(acceptLanguageHeader);
            } catch (error) {
                this.debug.warn('Failed to parse Accept-Language header:', error);
            }
        }

        if (typeof navigator !== 'undefined') {
            if (navigator.languages && navigator.languages.length > 0) {
                return Array.from(navigator.languages);
            }
            if (navigator.language) return [navigator.language];
        }

        return [];
    }

    private parseAcceptLanguageHeader(header: string): string[] {
        if (!header || typeof header !== 'string' || header.trim() === '') return [];

        try {
            return header
                .split(',')
                .map((part) => {
                    const trimmed = part.trim();
                    if (!trimmed || trimmed === '*') return null;
                    const [localePart, qPart] = trimmed.split(';q=');
                    const locale = localePart?.trim();
                    const q = qPart ? parseFloat(qPart) : 1.0;
                    if (!locale || isNaN(q) || q <= 0 || q > 1) return null;
                    return { locale, q };
                })
                .filter((item): item is { locale: string; q: number } => item !== null)
                .sort((a, b) => b.q - a.q)
                .map((item) => item.locale);
        } catch (error) {
            this.debug.warn('Error parsing Accept-Language header:', error);
            return [];
        }
    }

    private findBestLocaleMatch(userLocales: string[], supportedLocales: string[]): string | null {
        if (!userLocales.length || !supportedLocales.length) return null;

        const supported = supportedLocales.map((l) => canonicalizeLocale(l));

        // Pass 1: exact match in canonical form.
        for (const userLocale of userLocales) {
            const user = canonicalizeLocale(userLocale);
            if (supported.includes(user)) return user;
        }

        // Pass 2: same language + script after CLDR likely-subtags expansion
        // (`zh-TW` → zh-Hant, bare `zh` → zh-Hans), region ignored. This is
        // deliberately NOT bare-language truncation: a zh-Hant-TW user must
        // fall through unmatched rather than land on a zh/zh-Hans catalog.
        for (const userLocale of userLocales) {
            const userKey = maximizedLangScript(userLocale);
            if (!userKey) continue;
            const match = supported.find((s) => maximizedLangScript(s) === userKey);
            if (match) return match;
        }

        return null;
    }
}

export const LangsysApp = new LangsysAppClass();
export type { LangsysAppClass };

/**
 * Shaped as a locale, in the core's form: REF-1's pattern, letters and digits in hyphenated
 * subtags. A display locale is written into a request path, so anything else (`../projects`,
 * `es/es`, `es?x=1`) is refused unsent.
 */
function isLocaleShaped(locale: string): boolean {
    return typeof locale === 'string' && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/.test(locale);
}

/**
 * A locale form's list for `locale`, or undefined when the answer is not of its shape. Its
 * `data` is a map keyed by locale, in the organisation's code format, so the key is matched in
 * the core's form; the API writes an empty map as `[]`. A locale the map does not hold is an
 * empty list, and an entry is a list, or for the grouped form a map of lists.
 */
function localeEntry(data: unknown, locale: string, grouped: boolean, empty: () => unknown): unknown {
    if (Array.isArray(data)) return data.length === 0 ? empty() : undefined;
    if (typeof data !== 'object' || data === null) return undefined;
    const found = Object.entries(data).find(([key]) => wire3Locale(key) === locale);
    if (!found) return empty();
    const [, entry] = found;
    if (!grouped) return Array.isArray(entry) ? entry : undefined;
    // The grouped form's empty map is also written as `[]`.
    if (Array.isArray(entry)) return entry.length === 0 ? {} : undefined;
    if (typeof entry !== 'object' || entry === null) return undefined;
    return Object.values(entry).every((entries) => Array.isArray(entries)) ? entry : undefined;
}

/** WIRE-3's form of a locale identifier: trimmed, `_` read as `-`, lowercased, and nothing else. */
function wire3Locale(value: unknown): string {
    return typeof value === 'string' ? value.trim().replace(/_/g, '-').toLowerCase() : '';
}

/** A locale list with every entry's `code` in WIRE-3's form, in the flat or data shape or grouped by language. */
function withWire3Codes(listed: unknown): unknown {
    const recode = (entries: unknown): unknown =>
        Array.isArray(entries)
            ? entries.map((entry) =>
                  typeof entry === 'object' && entry !== null && typeof (entry as { code?: unknown }).code === 'string'
                      ? { ...entry, code: wire3Locale((entry as { code: string }).code) }
                      : entry
              )
            : entries;
    if (Array.isArray(listed)) return recode(listed);
    if (typeof listed !== 'object' || listed === null) return listed;
    return Object.fromEntries(Object.entries(listed).map(([language, entries]) => [language, recode(entries)]));
}
