import type { iCategories } from './translations.js';

/**
 * Minimum interface for a user-locale source.
 *
 * The SDK only ever READS and SUBSCRIBES to this — never writes. That lets
 * each framework adapt its native state into this shape with a small adapter:
 *
 *   - Svelte: a `writable<string>` satisfies this directly.
 *   - React:  wrap `useState` via `useSyncExternalStore` — a 5-line adapter.
 *   - Vue:    wrap `ref<string>` via `watch` + a `.value` getter.
 *   - Angular: a `BehaviorSubject<string>` satisfies this directly.
 *   - Vanilla: use the SDK's own `createSignal<string>('en-us')`.
 *
 * Designed as the smallest possible contract so framework wrappers stay thin.
 */
export interface LocaleSource {
    /** Read the current locale synchronously. */
    get(): string;
    /** Register a callback for locale changes. Returns an unsubscribe function. */
    subscribe(run: (locale: string) => void): () => void;
}

/**
 * A short-lived write grant (HS256 JWT) minted by the host app's own backend,
 * sent as `X-Write-Grant`. A valid grant makes the session write-enabled
 * server-side, so `write_enabled` comes back true and phrase discovery
 * registers normally — used by login-walled apps our discovery renderer
 * cannot reach.
 *
 * If the token only exists after login, still configure a PROVIDER at `init`
 * that returns `null` until then, rather than leaving `writeGrant` unset and
 * calling `setWriteGrant()` later. An unset grant tells the SDK that no grant
 * can ever arrive, so when authorization comes back read-only it releases the
 * queued misses — which for a login-walled app means they are only reported to
 * a renderer that cannot log in, which is the situation grants exist to solve.
 * A provider returning `null` keeps the queue held until the grant appears.
 *
 * Prefer the FUNCTION form. Grants have a ~5 minute TTL while `init()` runs
 * once and an app session can last hours, so a bare string is expired minutes
 * in and every later write silently degrades the session to read-only. The
 * provider is called immediately before each request, so the host app refreshes
 * by simply returning a fresh token. `null`/`undefined` means "no grant yet"
 * (e.g. before login) and is sent as no header at all.
 *
 * The resolved token is never cached — not on the config singleton, not on the
 * API client — which is what keeps it safe in a long-lived SSR process shared
 * across users.
 */
export type WriteGrant =
    | string
    | (() => string | null | undefined | Promise<string | null | undefined>);

export interface iLangsysInitConfig {
    /** The ID (UUID) of the project created in Langsys */
    projectid: string;

    /** The API key associated with the project */
    key: string;

    /**
     * A reactive source for the user's selected locale. See `LocaleSource`
     * for the minimum contract. The SDK's own `createSignal('en-us')` works
     * out of the box if you don't have a framework-native store of your own.
     */
    UserLocaleStore: LocaleSource;

    /**
     * Base language/locale for the source strings in your code.
     * @default 'en'
     */
    baseLocale?: string;

    /**
     * Point the SDK at a different API host — a local instance, a staging
     * host, or a stateful test double.
     *
     * Prefer this over `LangsysAppAPI.setBaseUrl()`. The setter has to run
     * BEFORE `init()`, and running it after leaves the SDK permanently inert:
     * `init()` has already authorized against the default host and failed, and
     * the locale subscription is installed closed over that failed result, so
     * it no-ops for the life of the app. Nothing throws, and no later locale
     * change or URL fix recovers it. This option is applied inside `init()`
     * before authorization, in the same call that consumes it, so there is no
     * ordering left to get wrong.
     *
     * @default 'https://api.langsys.dev/api'
     */
    apiUrl?: string;

    /**
     * Enable debug console messages.
     * @default false
     */
    debug?: boolean;

    /**
     * Emulate Langsys failure to load (for testing error handling).
     * @default false
     */
    emulateFailureToLoad?: boolean;

    /**
     * Token creation behavior during SSR.
     * @default 'client'
     */
    ssrTokenStrategy?: 'client' | 'server' | 'auto';

    /**
     * Pre-fetched translation data to bypass the initial API call.
     * Useful for SSR scenarios to avoid duplicate fetches.
     */
    initialTranslations?: iCategories;

    /** Locale that `initialTranslations` corresponds to. */
    initialTranslationsLocale?: string;

    /**
     * Short-lived write grant for login-walled apps. See `WriteGrant` — prefer
     * the function form; the bare string is quickstart-only. Can also be
     * supplied after `init()` via `LangsysApp.setWriteGrant()`.
     *
     * Note: configuring a grant makes write capability per-user, so a
     * process-level SSR write decision would be unsound. `ssrTokenStrategy`
     * therefore degrades to `'client'` while a grant is configured (logged at
     * init when `debug` is on).
     */
    writeGrant?: WriteGrant;
}

export interface iLangsysConfig {
    projectid: string;
    key: string;
    sUserLocale: LocaleSource;
    baseLocale: string;
    debug?: boolean;

    /**
     * Permission level of the API key, set automatically after successful
     * authorization. Display/debug only — NEVER branch on this.
     *
     * A public key shipped in browser JS is extractable, so write capability
     * is decided per-session by the server, not by the key alone: `ip_write`
     * keys are read-only everywhere except from allow-listed IPs. Use the
     * server-computed `writeEnabled` signal for every write decision. The
     * `(string & {})` arm keeps unknown future key types from breaking
     * downstream typechecks.
     */
    key_type?: 'read' | 'write' | 'ip_write' | (string & {});

    /** Short-lived write grant sent as `X-Write-Grant`. See `WriteGrant`. */
    writeGrant?: WriteGrant;

    /**
     * Token creation behavior during SSR.
     * - 'client': queue tokens for client-side sending (default)
     * - 'server': send tokens immediately from server
     * - 'auto':   send from server if few tokens, queue otherwise
     * @default 'client'
     */
    ssrTokenStrategy?: 'client' | 'server' | 'auto';
}
