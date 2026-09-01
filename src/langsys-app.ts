import { LangsysAppAPI } from './api.js';
import { canonicalizeLocale, maximizedLangScript } from './locale.js';
import { Logger, logger } from './logger.js';
import {
    autoDiscovery,
    batchLimit,
    config as configStore,
    currentlyLoadedLocale,
    sTranslations,
} from './stores.js';
import { noticeUnusableWriteCapability, Translations } from './translations.js';
import type { ResponseObject } from './types/api.js';
import type { iLangsysConfig, iLangsysInitConfig, WriteGrant } from './types/config.js';
import type { iCountryDialCode, iCountryList } from './types/countries.js';
import type { iCurrencyList } from './types/currencies.js';
import type { iLocaleData, iLocaleDefault, iLocaleFlat } from './types/locales.js';
import type { TFunction } from './types/translation-fn.js';
import type { iTranslations } from './types/translations.js';

class LangsysAppClass {
    private config: iLangsysConfig;

    public Translations: Translations;
    public translationsLoadingPromise: Promise<unknown> = Promise.resolve();

    private locales: Record<string, iLocaleData[]> = {};

    private countries: iCountryList = [];
    private countriesLocale = '';

    private dialCodes: iCountryDialCode[] = [];
    private dialCodesLocale = '';

    private currencies: iCurrencyList = [];
    private currenciesLocale = '';

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
            this.Translations.applyWriteEnabled(authData.write_enabled as boolean);
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
            this.Translations.applyWriteEnabled(legacy);
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

    public async refresh() {
        const locale = this.config.sUserLocale.get();
        this.locales = {};
        return this.Translations.change(locale, true);
    }

    /**
     * Initialize Langsys. Configuration must include at least `projectid`,
     * `key`, and `UserLocaleStore` (anything satisfying `LocaleSource` — see
     * its docstring for framework-specific adapters).
     */
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

        this.debug.debugEnabled = debug;

        // The module-scope `logger` singleton is a SEPARATE instance from the
        // per-class `this.debug` loggers, and nothing else ever writes its flag
        // — so anything gated on `logger.debugEnabled` was permanently off.
        // That silently disabled `warnUnmatchedParams` (unmatched `params` keys
        // in `<Translate>`/`<Phrase>`) for every consumer: the feature shipped,
        // typechecked, had tests, and could never fire. `init` is the one place
        // `debug` is resolved, so it is the right place to propagate it.
        logger.debugEnabled = debug;

        if (debug && initialTranslations) {
            this.debug.log('SSR initial translations config:', {
                hasInitialTranslations: !!initialTranslations,
                initialTranslationsLocale,
                categoriesProvided: initialTranslations ? Object.keys(initialTranslations).length : 0,
                categories: initialTranslations ? Object.keys(initialTranslations) : [],
            });
        }

        // Every early return below settles the ready() gate. No catalog is
        // coming on these paths, and `Phrase`/`Translate` await that gate
        // before rendering — so leaving it pending renders nothing, forever,
        // with no error, on the commonest misconfigurations there are.
        if (!projectid) {
            this.debug.error('LangsysApp.init missing projectid in configuration object!');
            this.Translations.settle();
            return { status: false, errors: ['Missing projectid'] };
        }
        if (!key) {
            this.debug.error('LangsysApp.init missing API key in configuration object!');
            this.Translations.settle();
            return { status: false, errors: ['Missing API key'] };
        }
        if (!UserLocaleStore?.subscribe || typeof UserLocaleStore.get !== 'function') {
            this.debug.error(
                "LangsysApp.init missing UserLocaleStore — pass any object satisfying LocaleSource (get + subscribe). createSignal('en-US') works if you have nothing of your own."
            );
            this.Translations.settle();
            return { status: false, errors: ['Missing UserLocaleStore'] };
        }

        // Lowercase `xx-yy` (`en-us`, `zh-hant-tw`) — the form the backend
        // stores and every internal cache key uses as the identity.
        baseLocale = canonicalizeLocale(baseLocale);

        // Before `validate()`, deliberately: authorizing against the default
        // host and then switching is the exact failure `setBaseUrl`-after-init
        // produces, and it is silent.
        if (initConfig.apiUrl) LangsysAppAPI.setBaseUrl(initConfig.apiUrl);

        if (!emulateFailureToLoad) {
            this.config = {
                projectid,
                key,
                sUserLocale: UserLocaleStore,
                baseLocale,
                debug,
                ssrTokenStrategy,
                writeGrant,
            };
            // Keep the exported config singleton in sync (used by Translate + API).
            Object.assign(configStore, this.config);
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
            // nothing else would resolve the gate.
            this.Translations.settle();
        }

        // Seed the translations store if initial data is provided (SSR handoff).
        if (initialTranslations && initialTranslationsLocale) {
            if (!initialTranslations['__uncategorized__']) {
                initialTranslations['__uncategorized__'] = {
                    __category__: '__uncategorized__',
                    __symbol__: '__uncategorized__',
                } as iTranslations;
            }
            for (const cat of Object.keys(initialTranslations)) {
                initialTranslations[cat]['__category__'] = cat;
            }
            sTranslations.set(initialTranslations);
            currentlyLoadedLocale.set(initialTranslationsLocale);
            this.debug.log('Populated sTranslations with initial data for locale:', initialTranslationsLocale);
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
        // caches and API routes only ever see BCP 47 canonical form.
        this.config.sUserLocale.subscribe((rawLocale) => {
            if (!validateResponse.status) return;
            const locale = canonicalizeLocale(rawLocale);
            this.getLocalesData(locale);
            this.debug.log('SUBSCRIBING TO USER LOCALE STORE');
            this.translationsLoadingPromise = this.Translations.change(locale, false);
        });

        return validateResponse;
    }

    public async getDialCodes(inLocale?: string): Promise<iCountryDialCode[]> {
        const locale = this.resolveLocale(inLocale);
        if (this.dialCodes.length && this.dialCodesLocale === locale) return this.dialCodes;

        const route = `countries/dial-codes/${locale}`;
        const response = await LangsysAppAPI.get(route);
        if (response.errors || !response.status) {
            this.debug.error('LangsysApp.getDialCodes failed: ' + route);
            return [];
        }
        this.dialCodes = response.data as iCountryDialCode[];
        this.dialCodesLocale = locale;
        return this.dialCodes;
    }

    public async getCurrencies(inLocale?: string): Promise<iCurrencyList> {
        const locale = this.resolveLocale(inLocale);
        if (this.currencies.length && this.currenciesLocale === locale) return this.currencies;

        const route = `currencies/${locale}`;
        const response = await LangsysAppAPI.get(route);
        if (response.errors || !response.status) {
            this.debug.error('LangsysApp.getCurrencies failed: ' + route);
            return [];
        }
        this.currencies = response.data as iCurrencyList;
        this.currenciesLocale = locale;
        return this.currencies;
    }

    public async getCountries(inLocale?: string): Promise<iCountryList> {
        const locale = this.resolveLocale(inLocale);
        if (this.countries.length && this.countriesLocale === locale) return this.countries;

        const route = `countries/${locale}`;
        const response = await LangsysAppAPI.get(route);
        if (response.errors || !response.status) {
            this.debug.error('LangsysApp.getCountries failed: ' + route);
            return [];
        }
        this.countries = response.data as iCountryList;
        this.countriesLocale = locale;
        return this.countries;
    }

    public async getCountryName(forCountryCode: string, inLocale?: string): Promise<string> {
        if (!forCountryCode) return '';
        const locale = this.resolveLocale(inLocale);
        if (!this.countries.length || this.countriesLocale !== locale) await this.getCountries(inLocale);

        const country = this.countries.find((c) => c.code.toLowerCase() === forCountryCode.toLowerCase())?.label;
        if (!country) this.debug.warn('getCountryName failed to match', forCountryCode);
        return country || forCountryCode;
    }

    public async getCurrencyName(forCurrencyCode: string, inLocale?: string): Promise<string> {
        if (!forCurrencyCode) return '';
        const locale = this.resolveLocale(inLocale);
        if (!this.currencies.length || this.currenciesLocale !== locale) await this.getCurrencies(inLocale);

        const currency = this.currencies.find((c) => c.code?.toLowerCase() === forCurrencyCode.toLowerCase())?.name;
        if (!currency) this.debug.warn('getCurrencyName failed to match', forCurrencyCode);
        return currency || forCurrencyCode;
    }

    public async getLocalesFormat(
        format: '' | 'flat' | 'data' = '',
        inLocale?: string
    ): Promise<iLocaleDefault | iLocaleFlat[] | iLocaleData[]> {
        const locale = this.resolveLocale(inLocale);
        const route = `locales/${locale}` + (format ? `/${format}` : '');
        const response = await LangsysAppAPI.get(route);
        if (response.errors || !response.status) {
            this.debug.error(response.errors, response.status, response);
            this.debug.error('LangsysApp.getLocales failed: ' + route);
            return format === 'flat' ? [] : format === 'data' ? [] : {};
        }
        switch (format) {
            case 'flat':
                return response.data as iLocaleFlat[];
            case 'data':
                return response.data as iLocaleData[];
            default:
                return response.data as iLocaleDefault;
        }
    }

    public async getLocalesFlat(inLocale?: string): Promise<iLocaleFlat[]> {
        return (await this.getLocalesFormat('flat', inLocale)) as iLocaleFlat[];
    }

    public async getLocalesData(inLocale?: string, forceRefresh = false): Promise<iLocaleData[]> {
        const locale = this.resolveLocale(inLocale);
        if (this.locales?.[locale]?.length && !forceRefresh) return this.locales[locale];
        this.locales[locale] = (await this.getLocalesFormat('data', inLocale)) as iLocaleData[];
        return this.locales[locale];
    }

    public async getLocales(inLocale?: string): Promise<iLocaleDefault> {
        return (await this.getLocalesFormat('', inLocale)) as iLocaleDefault;
    }

    public async getLocaleNameWithLookup(forLocale: string, shortName = false, inLocale?: string): Promise<string> {
        if (!forLocale) return '';
        const locale = this.resolveLocale(inLocale);
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
        const locale = this.resolveLocale(inLocale);

        // Distinguished from a lookup miss deliberately. Both return '', and
        // the old warning reported both as a failed match — sending developers
        // to check a locale code that was fine, when the real problem was that
        // nothing had been loaded to check it against.
        if (!this.locales[locale]?.length) {
            this.debug.warn(
                `getLocaleName('${forLocale}') called before locale data for '${locale}' was loaded — ` +
                    `run \`await getLocalesData('${locale}')\` first, or use \`await getLocaleNameWithLookup(...)\` instead.`
            );
            return '';
        }

        const target = canonicalizeLocale(forLocale);
        let name = '';
        this.locales[locale].every((loc) => {
            if (loc.code.toLowerCase() === target) {
                name = shortName ? loc.lang_name : loc.locale_name;
                return false;
            }
            return true;
        });
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

    /**
     * Resolve the effective locale for a data-fetching helper: explicit
     * argument, else the user's current locale, else the base locale — always
     * in the SDK's lowercase `xx-yy` form so cache keys and API routes agree.
     */
    private resolveLocale(inLocale?: string): string {
        return canonicalizeLocale(inLocale || this.config.sUserLocale.get() || this.config.baseLocale);
    }
}

export const LangsysApp = new LangsysAppClass();
export type { LangsysAppClass };
