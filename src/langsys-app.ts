import { LangsysAppAPI } from './api.js';
import { canonicalizeLocale, maximizedLangScript } from './locale.js';
import { Logger } from './logger.js';
import { config as configStore, currentlyLoadedLocale, sTranslations } from './stores.js';
import { Translations } from './translations.js';
import type { ResponseObject } from './types/api.js';
import type { iLangsysConfig, iLangsysInitConfig } from './types/config.js';
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

        this.debug.debugEnabled = debug;

        if (debug && initialTranslations) {
            this.debug.log('SSR initial translations config:', {
                hasInitialTranslations: !!initialTranslations,
                initialTranslationsLocale,
                categoriesProvided: initialTranslations ? Object.keys(initialTranslations).length : 0,
                categories: initialTranslations ? Object.keys(initialTranslations) : [],
            });
        }

        if (!projectid) {
            this.debug.error('LangsysApp.init missing projectid in configuration object!');
            return { status: false, errors: ['Missing projectid'] };
        }
        if (!key) {
            this.debug.error('LangsysApp.init missing API key in configuration object!');
            return { status: false, errors: ['Missing API key'] };
        }
        if (!UserLocaleStore?.subscribe || typeof UserLocaleStore.get !== 'function') {
            this.debug.error(
                "LangsysApp.init missing UserLocaleStore — pass any object satisfying LocaleSource (get + subscribe). createSignal('en-US') works if you have nothing of your own."
            );
            return { status: false, errors: ['Missing UserLocaleStore'] };
        }

        // BCP 47 canonical form (`en-US`, `zh-Hant-TW`) — the CLDR-compliant
        // backend and every internal cache key use this as the identity.
        baseLocale = canonicalizeLocale(baseLocale);

        if (!emulateFailureToLoad) {
            this.config = {
                projectid,
                key,
                sUserLocale: UserLocaleStore,
                baseLocale,
                debug,
                ssrTokenStrategy,
            };
            // Keep the exported config singleton in sync (used by Translate + API).
            Object.assign(configStore, this.config);
        }

        const validateResponse = await LangsysAppAPI.validate(this.config);

        if (validateResponse.status && validateResponse.data) {
            const authData = validateResponse.data as { key_type?: 'read' | 'write' };
            if (authData.key_type) {
                this.config.key_type = authData.key_type;
                configStore.key_type = authData.key_type;
                this.debug.log('API Key Type:', this.config.key_type);
            }
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

    public getLocaleName(forLocale: string, shortName = false, inLocale?: string): string {
        const locale = this.resolveLocale(inLocale);
        const target = canonicalizeLocale(forLocale).toLowerCase();
        let name = '';
        this.locales[locale]?.every((loc) => {
            if (loc.code.toLowerCase() === target) {
                name = shortName ? loc.lang_name : loc.locale_name;
                return false;
            }
            return true;
        });
        if (!name) this.debug.warn('getLocaleNameWithLookup failed to match', forLocale);
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
     */
    public detectPreferredLocale(
        acceptLanguageHeader?: string | null,
        supportedLocales?: string[]
    ): string | false {
        const userLocales = this.getUserLanguagePreferences(acceptLanguageHeader);
        if (userLocales.length === 0) return false;

        if (supportedLocales && supportedLocales.length > 0) {
            const bestMatch = this.findBestLocaleMatch(userLocales, supportedLocales);
            if (bestMatch) return bestMatch;
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
     * argument, else the user's current locale, else the base locale —
     * always in BCP 47 canonical form so cache keys and API routes agree.
     */
    private resolveLocale(inLocale?: string): string {
        return canonicalizeLocale(inLocale || this.config.sUserLocale.get() || this.config.baseLocale);
    }
}

export const LangsysApp = new LangsysAppClass();
export type { LangsysAppClass };
