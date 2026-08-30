import { LangsysAppAPI } from './api.js';
import { recordMissForDiscovery } from './discovery.js';
import { interpolate } from './interpolate.js';
import { canonicalizeLocale } from './locale.js';
import { Logger } from './logger.js';
import { createSignal, type Signal } from './signal.js';
import { batchLimit, currentlyLoadedLocale, scopeCatalogCache, sTranslations, setWriteEnabled, writeEnabled } from './stores.js';
import type { ResponseObject } from './types/api.js';
import type { iLangsysConfig } from './types/config.js';
import type { TFunction } from './types/translation-fn.js';
import type { iCategories, iTranslations } from './types/translations.js';

interface iTokenUpdate {
    projectid: string;
    category: string;
    token: string;
}

/**
 * `'auto'` SSR strategy: flush from the server while the queue is at or below
 * this size. Above it, `'auto'` defers to the client — which cannot receive the
 * queue across a real process boundary (see `shouldQueueForWrite`), so we also
 * stop collecting at that point rather than retaining tokens nothing will send.
 */
const AUTO_SSR_FLUSH_THRESHOLD = 5;

/**
 * Client-side flush debounce. Long enough that a burst of misses from one
 * render coalesces into a single POST, short enough that late-arriving content
 * is still registered inside the discovery renderer's post-scroll grace window.
 */
const CLIENT_FLUSH_DEBOUNCE_MS = 400;

/** Backstop period. Only runs while something is queued — see `ensureBackstop`. */
const BACKSTOP_INTERVAL_MS = 3000;

/**
 * Exponential backoff for a failing registration endpoint.
 *
 * A failed send leaves its batch queued so it can be retried — but the 3s
 * interval then retries unconditionally, so a persistently failing server
 * (a misconfigured CSRF rule, an outage, an expired key) gets a request every
 * 3 seconds for as long as the page is open, with the payload growing as new
 * misses accumulate. That is the same client-side amplification this feature's
 * hint lane goes to some length to prevent, on the lane that never got it.
 */
const RETRY_BACKOFF_BASE_MS = 3_000;
const RETRY_BACKOFF_MAX_MS = 300_000;

function isObject(test: unknown): test is Record<string, unknown> {
    return typeof test === 'object' && !Array.isArray(test) && test !== null;
}
function sameToken(a: iTokenUpdate, b: iTokenUpdate): boolean {
    return a.projectid === b.projectid && a.category === b.category && a.token === b.token;
}

/**
 * Lifecycle for app translations:
 *  - on-miss: any `t(cat, phrase)` whose phrase isn't in the catalog is
 *    queued as a "missing token" and (with write keys) flushed to the API.
 *  - locale changes trigger `change()` which fetches and replaces.
 *  - consumers can `subscribe(fn)` to react to translation snapshots.
 *  - frameworks subscribe to `tSignal` (which re-emits a fresh `TFunction`
 *    every time translations or the loaded locale change) so reactive
 *    templates re-render automatically.
 */
export class Translations {
    private config: iLangsysConfig;
    private locale: string;
    private lastLoaded: Record<string, number> = {};
    private missingTokens: iTokenUpdate[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushScheduled = false;
    private updateInFlight = false;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private consecutiveFailures = 0;
    /** Epoch ms before which no send may be attempted. See RETRY_BACKOFF_*. */
    private retryNotBefore = 0;
    private teardownInstalled = false;
    private isFirstClientRun = true;
    /** Process-level write decision for the SSR lane. See `canWrite`. */
    private ssrWriteEnabled: boolean | undefined = undefined;
    private readyResolve: () => void = () => {};
    private readyPromise: Promise<void> = new Promise((resolve) => {
        this.readyResolve = resolve;
    });
    public debug: Logger;

    /** Reactive holder for the current translation function. Re-emits on every catalog/locale change. */
    public tSignal: Signal<TFunction>;

    constructor(config: iLangsysConfig) {
        this.config = config;
        this.debug = new Logger(!!config.debug);
        this.locale = canonicalizeLocale(config.baseLocale || '');

        // A FRESH closure per emit, and that is a contract, not an accident.
        // `Signal.set` drops a value that is `Object.is`-equal to the current
        // one (`signal.ts`), so identity IS the change signal every binding
        // subscribes to. Memoizing `buildTFn` — the obvious optimization, since
        // the closure body never varies — makes every `set` a no-op: no
        // subscriber fires, nothing throws, and every consumer renders stale
        // text while the correct catalog sits in the store.
        //
        // The closure reads `sTranslations` at CALL time, so a stable reference
        // would still return fresh values to anyone who called it. That is what
        // makes the failure so quiet: `t()` is right, and nobody re-renders to
        // ask it. Pinned by `tfunction-identity.test.ts`.
        this.tSignal = createSignal<TFunction>(this.buildTFn());
        sTranslations.subscribe(() => this.tSignal.set(this.buildTFn()));
        currentlyLoadedLocale.subscribe(() => this.tSignal.set(this.buildTFn()));

        // Misses collected before authorization resolved (or before a write
        // grant arrived) are held, not dropped — flush them the moment the
        // session turns out to be write-enabled.
        writeEnabled.subscribe((enabled) => {
            if (!this.missingTokens.length) return;
            if (enabled === true) {
                this.scheduleTokenFlush();
            } else if (enabled === false && !LangsysAppAPI.hasWriteGrant()) {
                // Authorization came back read-only and no grant can change
                // that, so these can never be sent. They were recorded by the
                // discovery lane when they missed, so releasing them loses
                // nothing and keeps a long-lived session from holding a queue
                // that will never drain.
                this.debug.log(`Releasing ${this.missingTokens.length} held tokens (session is read-only)`);
                this.missingTokens = [];
                // Nothing will ever be queued again on this session, so the
                // backstop has nothing left to back up. Without this it keeps
                // ticking every 3s for the life of the page: `updateTokens`
                // returns early on an empty queue, before reaching the disarm.
                this.stopBackstop();
            }
        });

        if (config.key && config.projectid) this.setup(config);
    }

    /**
     * Resolves once the first `getTranslations` call has completed (or
     * immediately if no fetch is configured). Callers that need to read
     * `sTranslations` before issuing a write — e.g. the `Translate` DOM
     * class deciding whether to POST a content block — should await this
     * to avoid acting on an empty cache during the cold-start race.
     */
    public ready(): Promise<void> {
        return this.readyPromise;
    }

    /**
     * Resolve `ready()` without a catalog, for the paths where none is coming:
     * `init` refused the config, or authorization failed.
     *
     * `Phrase` and `Translate` both await this gate before rendering, so
     * leaving it pending on those paths is not a degraded mode — it is a
     * permanent blank render, with no error, on the commonest misconfigurations
     * there are. Settling makes them fall back to their source text, which is
     * what an SDK that cannot reach its backend should show.
     *
     * Idempotent. A later successful load still updates the stores and
     * re-renders every subscriber.
     */
    public settle(): void {
        this.readyResolve();
    }

    /** Current translation function. Reads fresh state on every call. */
    public get t(): TFunction {
        return this.tSignal.get();
    }

    /** Subscribe to translation snapshot changes. Fires immediately with the current value. */
    public subscribe(run: (value: iCategories) => void) {
        return sTranslations.subscribe(run);
    }

    /**
     * Content-block-keyed lookup used by the DOM `Translate` class.
     * Returns the per-token translation inside a content block, or `null` if
     * either the content block or the inner token is missing. Never registers
     * a missing token — the DOM class manages its own lifecycle via content blocks.
     */
    public lookupContent(category: string, customId: string, token: string): string | null {
        const cats = sTranslations.get();
        const lookupCat = category || '__uncategorized__';
        const contentData = cats[lookupCat]?.[customId];
        if (!contentData || typeof contentData !== 'object') return null;
        const value = (contentData as unknown as Record<string, string>)[token];
        return typeof value === 'string' ? value : null;
    }

    /**
     * Raw stored translation for a phrase, without interpolation or
     * missing-token registration. Returns null when no (non-empty) translation
     * is cached. Used by the `Phrase` rich-text handler, which needs the
     * un-interpolated template (it supplies its own markup-token values).
     */
    public lookup(phrase: string, category: string): string | null {
        const cats = sTranslations.get();
        const lookupCat = category || '__uncategorized__';
        const value = cats[lookupCat]?.[phrase];
        return typeof value === 'string' && value.length > 0 ? value : null;
    }

    private buildTFn(): TFunction {
        // Single runtime body covers both overload shapes. Position 2 is the
        // discriminator: string ⇒ category, object ⇒ params (no category).
        //   t(phrase)                                  → category='', params=undefined
        //   t(phrase, {params...})                     → category='', params={params}
        //   t(phrase, 'Category')                      → category='Category', params=undefined
        //   t(phrase, 'Category', {params...})         → category='Category', params={params}
        const fn = ((phrase: string, ...rest: unknown[]): string => {
            const category = typeof rest[0] === 'string' ? rest[0] : '';
            const params = (typeof rest[0] === 'object' ? rest[0] : rest[1]) as Record<string, unknown> | undefined;

            const cats = sTranslations.get();
            // '__uncategorized__' is a server-internal bucket name used only
            // in GET /translations responses to group null-category phrases.
            // We normalize to it for the local cats lookup (so we read from
            // the same bucket the server writes to), but we MUST NOT leak
            // the sentinel back into the missingToken queue — that queue
            // feeds the POST wire payload, and clients are not allowed to
            // send the reserved sentinel as a category.
            const lookupCat = category || '__uncategorized__';
            const bucket = cats[lookupCat];

            // KEY PRESENCE, not truthiness. Three states, and the middle one is
            // common rather than exotic:
            //   1. key absent            — never seen. A genuine miss.
            //   2. key present, value null — registered, translation still being
            //      produced by MT (a minute or two).
            //   3. key present, non-empty  — translated.
            // States 2 and 3 both render the source-text fallback, but only
            // state 1 may register/report. Collapsing 2 into 1 would make every
            // visitor during the MT window re-report content that was already
            // registered — worst on exactly the projects with the most
            // untranslated content, which is the amplification this design
            // exists to prevent.
            //
            // `hasOwnProperty` rather than `in`: the catalog comes from
            // JSON.parse and so inherits Object.prototype, and `in` walks the
            // chain — `t('toString')` and `t('constructor')` would read as
            // already-known and never register.
            const known = !!bucket && Object.prototype.hasOwnProperty.call(bucket, phrase);
            const value = known ? bucket[phrase] : undefined;

            let translated: string;
            if (typeof value === 'string' && value.length > 0) {
                this.debug.log('TRANSLATION FOUND', [lookupCat, phrase, value]);
                translated = value;
            } else {
                if (!known) this.missingToken(category, phrase);
                translated = phrase;
            }

            return params ? interpolate(translated, params, currentlyLoadedLocale.get()) : translated;
        }) as TFunction;
        return fn;
    }

    private missingToken(category: string, token: string | undefined | null) {
        if (token === undefined || token === null) {
            return this.debug.warn(`Received undefined or null token for category: ${category}`);
        }

        // Skip content-block id lookups (32-hex md5 strings).
        if (/^[0-9a-f]{32}$/.test(token)) return;
        if (token === 'toJSON') {
            this.debug.error(`Received toJSON as token ${category}:${token}`, token);
            return;
        }
        if (token === '') {
            this.debug.warn('Received empty token', token);
            return;
        }

        // NOTE: no write-capability check here. It used to live at this line as
        // `key_type !== 'write'`, which cannot express the current model — an
        // `ip_write` key is read-only everywhere except from allow-listed IPs,
        // and the discovery renderer relies on running this exact, unmodified
        // path from such an IP. Worse, gating COLLECTION means a `t()` call
        // landing before `validate()` resolves is dropped forever. The decision
        // now happens at the flush site, so pre-authorization misses are held
        // rather than discarded, and the lane is chosen once it's actually known.
        //
        // REG-11 — an ellipsis in the phrase itself is usually upstream
        // truncation: the truncated form gets translated and stored, never
        // matches the full paragraph, and the paragraph later registers as a
        // second phrase. Catalog pollution plus double translation spend.
        //
        // WARN ONLY, deliberately. A blanket skip has real false positives —
        // "Loading…", "Saving…", "Please wait…" are legitimate phrases — and
        // silently refusing to register them would create a NEW silent failure,
        // which is the class this whole surface exists to remove. The spec
        // permits suppression only on a second signal (a longer catalog entry
        // sharing the prefix); that is not implemented here, so nothing is
        // skipped. Note CSS truncation needs no handling: `text-overflow` and
        // `-webkit-line-clamp` clip visually and leave the DOM text complete.
        if (/(?:…|\.\.\.)\s*$/.test(token)) {
            this.debug.warn(
                `Langsys: phrase ends in an ellipsis — "${token}". If this is upstream truncation, the ` +
                    `shortened form will be translated and stored, and the full text will later register as a ` +
                    `separate phrase. Register the untruncated string if you can. Registering anyway.`
            );
        }

        // Recorded before the queue dedup below: the discovery lane keys on the
        // URL the miss occurred on, and a phrase already queued from an earlier
        // route must not suppress the record for the page being viewed now.
        recordMissForDiscovery(category, token);

        // Discovery has it; only hold it for registration if that queue can
        // actually drain. See `shouldQueueForWrite`.
        if (!this.shouldQueueForWrite()) {
            this.debug.log('Not queueing for registration (no reachable flush path)', { category, token });
            return;
        }

        const missingToken: iTokenUpdate = { category, token, projectid: this.config.projectid };
        if (!this.missingTokens.some((t) => sameToken(t, missingToken))) {
            this.debug.log('MISSING TOKEN LOOKUP FAILED', [missingToken, [...this.missingTokens], { ...sTranslations.get() }]);
            this.missingTokens.push(missingToken);
            this.scheduleTokenFlush();
        }
    }

    /**
     * Whether this session may write. The single decision point for the write
     * lane — never infer capability from `key_type`.
     *
     * In the browser the server-computed signal is authoritative, and `undefined`
     * (not yet authorized) correctly holds rather than writing or hinting.
     *
     * Under SSR the signal is deliberately never written (it is a process-wide
     * singleton and write capability is per-session), so we fall back to the
     * value the last catalog fetch reported for THIS process. That is only sound
     * while capability depends on the server's IP alone, which is constant for
     * the process. A configured write grant makes it per-user instead, so the
     * server lane is unsafe and we degrade to flushing after hydration — where
     * the decision is per-user and correct.
     */
    private canWrite(): boolean {
        if (typeof window !== 'undefined') return writeEnabled.get() === true;
        if (LangsysAppAPI.hasWriteGrant()) return false;
        return this.ssrWriteEnabled === true;
    }

    /**
     * Record the server's write decision from an `authorize-project` or catalog
     * response. Browser: updates the shared signal. Server: keeps a
     * process-level copy used only when no grant is configured (see `canWrite`).
     */
    public applyWriteEnabled(value: boolean | undefined): void {
        if (typeof value !== 'boolean') return;
        setWriteEnabled(value);
        if (typeof window === 'undefined') this.ssrWriteEnabled = value;
    }

    /**
     * Whether a miss is worth holding in the REGISTRATION queue. Distinct from
     * `canWrite()`, which decides whether to send: this decides whether keeping
     * it could ever lead to a send.
     *
     * What happens to a declined miss differs by arm, and the difference is
     * load-bearing rather than incidental:
     *
     *  - In the BROWSER the discovery lane has already recorded it, so the page
     *    is still reported and nothing is lost.
     *  - Under SSR it is recorded NOWHERE — `recordMissForDiscovery` bails
     *    without a `window`. The safety net there is that the client re-runs
     *    `t()` after hydration and re-collects, which covers content rendered
     *    on both sides and does NOT cover content that only ever executes
     *    server-side. That gap is real and documented rather than closed.
     *
     * Two ways a queue becomes undrainable:
     *
     * SSR under `'client'` — the queue is meant to be flushed after hydration
     * by `setup()`, but that reads the BROWSER's instance of this module. The
     * push happened in the Node process's instance. Under real SSR (Next,
     * Remix, Astro) those are different objects in different processes, and no
     * channel carries tokens client-ward — `initialTranslations` goes the other
     * way. So the tokens are silently dropped AND retained forever, since the
     * 3s drain timer only exists in the browser branch of `setup()`. In a
     * long-lived server that plateaus at "every phrase the app has ever
     * server-rendered", held live and never sent. Declining to collect makes
     * the limitation explicit instead of silent: server-side discovery requires
     * `ssrTokenStrategy: 'server'`.
     *
     * Browser, definitively read-only — `writeEnabled` is `false` and no grant
     * is configured, so no path exists by which this session becomes writable.
     * (`undefined` still queues: capability isn't known yet and those misses
     * must be held, not dropped. A configured grant also queues, since one
     * arriving flips the session write-enabled.)
     */
    private shouldQueueForWrite(): boolean {
        if (typeof window === 'undefined') {
            // A configured grant makes the SSR write lane unusable — `canWrite`
            // refuses it, because capability is then per-user and this queue is
            // process-wide. Collecting anyway rebuilds precisely the
            // undrainable plateau this method exists to prevent: nothing here
            // can ever send it, and the `writeEnabled` release path can't fire
            // either, since that signal is never written server-side. The
            // degradation to the client lane is real, so the server instance
            // must also stop collecting — not just stop sending.
            if (LangsysAppAPI.hasWriteGrant()) return false;

            const strategy = this.config.ssrTokenStrategy || 'client';
            if (strategy === 'server') return true;
            if (strategy === 'auto') {
                // Past the threshold 'auto' defers to a client that can't receive it.
                return this.missingTokens.length < AUTO_SSR_FLUSH_THRESHOLD;
            }
            return false;
        }

        if (writeEnabled.get() === false && !LangsysAppAPI.hasWriteGrant()) return false;
        return true;
    }

    private scheduleTokenFlush() {
        const strategy = this.config.ssrTokenStrategy || 'client';
        const isSSR = typeof window === 'undefined';

        if (isSSR) {
            switch (strategy) {
                case 'server':
                    if (!this.flushScheduled) {
                        this.flushScheduled = true;
                        queueMicrotask(() => void this.updateTokens());
                    }
                    break;

                case 'auto':
                    if (this.missingTokens.length <= AUTO_SSR_FLUSH_THRESHOLD && !this.flushScheduled) {
                        this.flushScheduled = true;
                        queueMicrotask(() => void this.updateTokens());
                    }
                    break;

                case 'client':
                default:
                    this.debug.log('SSR: Queuing tokens for client-side transmission');
                    break;
            }
        } else {
            // Client — debounce briefly so a burst of misses coalesces into one
            // POST, then send. It used to wait for the next 3s interval tick
            // (the immediate path was gated on `!this.timer`, so it only ever
            // ran before setup() installed the timer), which meant any content
            // rendering after init was held for up to 3s. That is fatal for
            // late-arriving content: the discovery renderer grants roughly 4s
            // after its scroll phase, so an up-to-3s hold left about 1s of real
            // budget, and anything past it was recorded and then destroyed with
            // the page. Lazy-loaded and streamed content — precisely what the
            // renderer exists to discover — is the common case for that.
            if (!this.flushScheduled) {
                this.flushScheduled = true;
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    this.debounceTimer = null;
                    void this.updateTokens();
                }, CLIENT_FLUSH_DEBOUNCE_MS);
            }

            // Arm the backstop only now that something is actually queued.
            this.ensureBackstop();
        }
    }

    /**
     * Start the backstop interval if it isn't already running.
     *
     * Demand-driven deliberately. It used to start in `setup()` and run for the
     * life of the page whether or not anything was ever queued — a wakeup every
     * three seconds forever, for a queue that is empty almost all of the time.
     * That is a battery and background-work cost on mobile, and React Native
     * takes this same branch because it defines `window`.
     *
     * The tick disarms itself once the queue drains; the next miss re-arms it
     * through `scheduleTokenFlush`. While sends keep failing the queue stays
     * non-empty and the interval keeps running, which is the case a backstop
     * exists for.
     */
    private ensureBackstop(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.updateTokens(), BACKSTOP_INTERVAL_MS);
        this.debug.log('UPDATE TOKEN INTERVAL', this.timer);
    }

    private stopBackstop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * Stop background work. Queued tokens stay queued, and further discovery
     * re-arms the backstop — this releases the timer, it does not discard work.
     */
    public destroy(): void {
        this.stopBackstop();
    }

    /**
     * Send whatever is still queued while the page is going away.
     *
     * Even with the debounce there is always a window where a miss is queued
     * and the document is torn down — a tab closing, a client-side navigation,
     * or the discovery renderer finishing its grace period. A normal request is
     * cancelled with the document; `keepalive` survives it.
     *
     * Deliberately NOT `navigator.sendBeacon`, the usual answer here: it cannot
     * set custom headers, and our authorization is `x-Authorization`, so every
     * beacon would be rejected.
     *
     * Fire-and-forget with no local bookkeeping — the page is leaving, so there
     * is no "after" in which a cache write or queue mutation could matter, and
     * skipping them keeps this off the critical path of teardown.
     */
    private flushOnTeardown(): void {
        if (!this.missingTokens.length) return;
        this.debug.log(`Teardown flush: sending ${this.missingTokens.length} queued tokens with keepalive`);

        // The ordinary flush path, only with keepalive — NOT a bespoke
        // fire-and-forget send. `visibilitychange → hidden` also fires on a
        // plain tab switch, where the page does not go away; a send that
        // skipped the bookkeeping would leave everything queued and the 3s
        // backstop would re-send it all on return. Reusing the normal path
        // means the queue is cleared and the catalog updated exactly as usual
        // when the page survives, and when it genuinely dies the request is
        // already dispatched and the unrun bookkeeping costs nothing.
        void this.updateTokens(true);
    }

    /**
     * `visibilitychange → hidden` is the reliable teardown signal; `pagehide`
     * backs it up. `unload`/`beforeunload` are deliberately not used — they are
     * unreliable on mobile and block bfcache.
     */
    private installTeardownFlush(): void {
        if (this.teardownInstalled) return;
        if (typeof document === 'undefined' || typeof window === 'undefined') return;
        this.teardownInstalled = true;

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') this.flushOnTeardown();
        });
        window.addEventListener('pagehide', () => this.flushOnTeardown());
    }

    public setup(config: iLangsysConfig) {
        this.config = config;
        if (!this.config.projectid || !this.config.key) return;

        if (this.config.debug) this.debug.debugEnabled = this.config.debug;
        if (config.baseLocale) this.locale = canonicalizeLocale(config.baseLocale);

        this.debug.log('TRANSLATION SETUP INITIATED', this.config);

        if (typeof window !== 'undefined') {
            if (this.isFirstClientRun && this.missingTokens.length > 0) {
                this.isFirstClientRun = false;
                const strategy = this.config.ssrTokenStrategy || 'client';
                if (strategy === 'client' || (strategy === 'auto' && this.missingTokens.length > 5)) {
                    this.debug.log(`Post-hydration: Flushing ${this.missingTokens.length} SSR-collected tokens`);
                    queueMicrotask(() => this.updateTokens());
                }
            }

            this.installTeardownFlush();

            // Backstop only — the debounce in scheduleTokenFlush is what
            // actually sends. This catches anything a failed send left queued,
            // and runs only while there IS something queued: a fresh setup
            // re-arms it iff a backlog survived (an SSR handoff, or a previous
            // setup on this instance).
            this.stopBackstop();
            if (this.missingTokens.length) this.ensureBackstop();
        } else {
            const strategy = this.config.ssrTokenStrategy || 'client';
            this.debug.log(`SSR environment detected - using '${strategy}' token strategy`);
        }
    }

    /**
     * Record that a locale's catalog is already present without fetching —
     * e.g. after an SSR handoff seeds `sTranslations` + `currentlyLoadedLocale`.
     * This primes the same `lastLoaded` cache `change()` consults, so the first
     * settle for that locale is a cache hit (no redundant fetch) while every
     * later switch *to* it still flows through `change()` normally.
     */
    public markLoaded(locale: string): void {
        if (!locale) return;
        locale = canonicalizeLocale(locale);
        this.locale = locale;
        this.lastLoaded[locale] = new Date().getTime() / 1000;
        // A seeded catalog counts as "ready": the cache hit above means no
        // fetch will ever fire to resolve the promise, and content-block /
        // Phrase consumers awaiting ready() would otherwise hang forever.
        this.readyResolve();
    }

    /**
     * React to a user-locale change. Fetches translations if we haven't
     * loaded this locale within the last 60s (or if forced).
     */
    public async change(locale: string, force = false, skipFetch = false): Promise<boolean> {
        if (!locale) return false;
        if (!this.config.projectid || !this.config.key) return false;
        // Canonical form is the cache identity — `en-us` and `en-US` must hit
        // the same `lastLoaded` entry and compare equal to `this.locale`.
        locale = canonicalizeLocale(locale);

        // Point the cache at this project+locale BEFORE anything reads or
        // writes the catalog. A hit warms the start; a miss simply misses.
        // Previously the cache was keyed by neither, so a page load restored
        // whatever was stored and served it until a fetch replaced it.
        scopeCatalogCache(`${this.config.projectid}:${locale}`);

        if (skipFetch) {
            this.debug.log('Using pre-fetched translations for locale', locale);
            this.locale = locale;
            this.lastLoaded[locale] = new Date().getTime() / 1000;
            this.readyResolve();
            return true;
        }

        const now = new Date().getTime() / 1000;
        if (
            !force &&
            locale === this.locale &&
            this.lastLoaded[locale] &&
            Math.abs(this.lastLoaded[locale] - now) < 60
        ) {
            return false;
        }

        this.debug.log('Locale change detected!', locale);
        this.locale = locale;
        await this.getTranslations();
        return true;
    }

    /**
     * Record a failed send and push the next attempt out exponentially:
     * 3s, 6s, 12s … capped at 5 minutes. Reset on the first success.
     */
    private noteSendFailure(): void {
        this.consecutiveFailures += 1;
        const delay = Math.min(
            RETRY_BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1),
            RETRY_BACKOFF_MAX_MS,
        );
        this.retryNotBefore = Date.now() + delay;
        this.debug.log(`Registration send failed (${this.consecutiveFailures}x); next attempt in ${delay}ms`);
    }

    private async updateTokens(keepalive = false): Promise<boolean> {
        // The scheduled flush has now started, so release the scheduling latch.
        // `flushScheduled` guards only the window between scheduling and
        // execution — holding it until the POST resolves would swallow the
        // follow-up flush this method schedules in its own `finally`.
        this.flushScheduled = false;

        // The 3s interval calls this unconditionally, so without a lock a call
        // can start while a previous one is still awaiting its POST — which
        // re-sends the same tokens (they aren't cleared until the response
        // lands) and makes the "what did I actually send" bookkeeping below
        // ill-defined.
        // `keepalive` means this is the teardown flush, and neither of the two
        // guards below applies to it. The in-flight request is about to die
        // with the document and its batch is still queued, so deferring to it
        // loses exactly the work teardown exists to save; and a backoff window
        // is about waiting for a *later* attempt, of which there will be none.
        // Re-sending is safe: registration is idempotent server-side (advisory
        // lock plus ON CONFLICT), so a duplicate costs a request, while
        // deferring costs the content.
        const isTeardown = keepalive;

        if (!isTeardown && this.updateInFlight) return false;
        if (!this.missingTokens.length) {
            // Disarm here as well as at the sites that empty the queue. Those
            // are the immediate path; this is the structural one, so a future
            // path that empties the queue without knowing about the backstop
            // cannot leave it spinning.
            this.stopBackstop();
            return false;
        }
        if (!isTeardown && this.retryNotBefore && Date.now() < this.retryNotBefore) return false;
        if (!this.config.projectid || !this.config.key) return false;
        if (!this.canWrite()) {
            this.debug.log('Skipping token updates (session is not write-enabled)', {
                writeEnabled: writeEnabled.get(),
                key_type: this.config.key_type || 'unknown',
            });
            return false;
        }

        if (typeof window === 'undefined') {
            this.debug.log(`Sending ${this.missingTokens.length} tokens from SSR`);
        }

        const currentData = sTranslations.get();
        this.missingTokens = this.missingTokens.filter((tokenObj) => {
            tokenObj.projectid = this.config.projectid;
            // The server response keys null-category phrases under
            // '__uncategorized__', so map empty client-side category to that
            // bucket for the dedup check only. The queue itself keeps the
            // original (possibly empty) category for the wire payload.
            const lookupCat = tokenObj.category || '__uncategorized__';
            // hasOwnProperty, not `in` — same prototype-chain hazard as the
            // lookup in `t()`. With `in`, a phrase named `toString` or
            // `constructor` is queued by `t()` (which tests own properties) and
            // then silently filtered out of every send here, so it re-queues
            // forever and is never registered.
            const bucket = currentData[lookupCat];
            if (bucket && Object.prototype.hasOwnProperty.call(bucket, tokenObj.token)) {
                this.debug.log('Missing token already exists! Skipping:', {
                    category: tokenObj.category,
                    token: tokenObj.token,
                    existing: currentData[lookupCat][tokenObj.token],
                });
                return false;
            }
            return true;
        });

        if (!this.missingTokens.length) return false;

        // Snapshot the batch. Everything below operates on THIS list and never
        // on the live array, because `t()` keeps running during the awaits:
        // a miss recorded mid-flight would otherwise be marked present in the
        // catalog and wiped from the queue without ever having been in a
        // payload — and since it then reads as already-registered, it would
        // never be retried. Silent, permanent loss, and the window is every
        // in-flight POST (a modal opening, a route change, lazy content
        // resolving), worst on a first visit when the catalog is emptiest.
        const batch = [...this.missingTokens];
        let drained = false;

        // The teardown flush deliberately doesn't take the lock — it ran past
        // it above, so it must not clear a lock a live request still owns.
        if (!isTeardown) this.updateInFlight = true;
        this.debug.log('CREATE MISSING TOKENS', batch);
        try {
            // Wire boundary: empty category → null. '__uncategorized__' is
            // server-internal and is rejected as a client input.
            const phraseItems = batch.map((tokenObj) => ({
                type: 'phrase',
                phrase: tokenObj.token,
                category: tokenObj.category || null,
            }));

            // /translatable-items caps each request (default 200 items); chunk so
            // a page registering many new phrases at once never overflows it.
            // Keepalive requests share a ~64KB budget across everything in
            // flight, well below what 200 phrases can reach — and an oversized
            // keepalive request is rejected by the browser, losing the batch at
            // exactly the moment there is no retry left. So the teardown path
            // really does chunk more conservatively than the normal one, which
            // until now was only claimed in a comment.
            const BATCH_SIZE = isTeardown ? Math.min(50, batchLimit.get()) : batchLimit.get();
            for (let offset = 0; offset < phraseItems.length; offset += BATCH_SIZE) {
                const response: ResponseObject = await LangsysAppAPI.createTranslatableItems(
                    phraseItems.slice(offset, offset + BATCH_SIZE),
                    { keepalive },
                );
                if (!response.status) {
                    if (response.errors) {
                        this.debug.log('TOKEN UPDATE FAIL', batch);
                        this.debug.error('Error updating project tokens', response.errors);
                    }
                    // Leave the batch queued — a failed send must be retryable.
                    this.noteSendFailure();
                    return false;
                }
            }

            // Re-read: a catalog fetch may have replaced the store while we were
            // in flight, and writing back the pre-await snapshot would clobber it.
            const latest = sTranslations.get();
            batch.forEach((tokenObj) => {
                // Same bucket normalization as the dedup check: write into
                // the cats bucket that matches the server response shape.
                const lookupCat = tokenObj.category || '__uncategorized__';
                if (!latest[lookupCat]) {
                    latest[lookupCat] = {
                        __category__: lookupCat,
                        __symbol__: lookupCat,
                    } as iTranslations;
                }
                latest[lookupCat][tokenObj.token] = tokenObj.token;
                latest[lookupCat]['__category__'] = lookupCat;
            });
            sTranslations.set({ ...latest });

            // Remove exactly what was sent, never `= []`.
            this.missingTokens = this.missingTokens.filter((queued) => !batch.some((s) => sameToken(s, queued)));
            drained = true;
            this.consecutiveFailures = 0;
            this.retryNotBefore = 0;
            return true;
        } catch (err) {
            this.debug.log('CREATE MISSING TOKEN FAILURE', batch);
            this.debug.error('Error updating project tokens', err);
            this.noteSendFailure();
            return false;
        } finally {
            if (!isTeardown) this.updateInFlight = false;
            // Anything recorded during the flush is still queued. The browser's
            // 3s timer would eventually take it, but SSR has no timer at all —
            // without this the remainder would sit unsent for the process's life.
            // Guarded on an actual successful drain, so a persistently failing
            // send retries on the normal cadence rather than spinning here.
            if (drained && this.missingTokens.length) this.scheduleTokenFlush();

            // Nothing left to back off for. Placed here rather than on the tick
            // so the debounced send disarms it too — otherwise the interval
            // outlives its queue by up to one full period, every time.
            if (!this.missingTokens.length) this.stopBackstop();
        }
    }

    private async getTranslations(): Promise<void> {
        if (!LangsysAppAPI.config.projectid && this.config.projectid) {
            LangsysAppAPI.setup(this.config);
        }

        const response: ResponseObject = await LangsysAppAPI.getTranslations(this.locale);
        this.debug.log('GET TRANSLATIONS API RESPONSE', response);

        // Envelope-level, alongside `words` / `untranslated_words` — never
        // inside `data`, which IS the category map. Refreshed on every catalog
        // fetch so a capability change (a grant arriving, an IP allow-list
        // edit) is picked up without re-running init.
        this.applyWriteEnabled(response.write_enabled);

        if (response.errors) {
            this.debug.error('Error', response.errors[0]);
            this.readyResolve();
            return;
        }

        // An empty project serializes `data` as `[]`, not `{}`. Left as an
        // array it would be persisted to localStorage by JSON.stringify with
        // the seeded `__uncategorized__` bucket silently dropped (string
        // properties on arrays don't survive serialization).
        const trans = (isObject(response.data) ? response.data : {}) as iCategories;

        if (!isObject(trans['__uncategorized__'])) {
            trans['__uncategorized__'] = {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
            } as iTranslations;
        }

        for (const cat of Object.keys(trans)) {
            trans[cat]['__category__'] = cat;
        }

        this.debug.log('GET TRANSLATIONS ' + this.locale, trans);

        sTranslations.set(trans);
        // Small delay so consumers see translations + locale updates on the same tick.
        setTimeout(() => currentlyLoadedLocale.set(this.locale), 100);
        this.lastLoaded[this.locale] = new Date().getTime() / 1000;
        this.readyResolve();
    }
}

export default Translations;
