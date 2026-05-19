import type { Signal } from '../signal.js';
import type { iCategories } from './translations.js';

export interface iLangsysInitConfig {
    /** The ID (UUID) of the project created in Langsys */
    projectid: string;

    /** The API key associated with the project */
    key: string;

    /**
     * A reactive holder for the user's selected locale. Accepts any object
     * with `subscribe`, `set`, and `get` methods (our `Signal<string>` works
     * out of the box). Use `createSignal('en-us')` if you have nothing of your own.
     */
    UserLocaleStore: Signal<string>;

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
    sUserLocale: Signal<string>;
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
