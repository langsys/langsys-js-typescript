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
}

export interface iLangsysConfig {
    projectid: string;
    key: string;
    sUserLocale: LocaleSource;
    baseLocale: string;
    debug?: boolean;

    /** Permission level of the API key, set automatically after successful authorization. */
    key_type?: 'read' | 'write';

    /**
     * Token creation behavior during SSR.
     * - 'client': queue tokens for client-side sending (default)
     * - 'server': send tokens immediately from server
     * - 'auto':   send from server if few tokens, queue otherwise
     * @default 'client'
     */
    ssrTokenStrategy?: 'client' | 'server' | 'auto';
}
