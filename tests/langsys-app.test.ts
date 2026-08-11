import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';
import { config, currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import type { iCategories } from '../src/types/translations.js';

/**
 * `LangsysApp` is a module singleton, so every test here mutates shared state:
 * the exported `config` object, the locale subscription list, and the private
 * locales/countries caches. Each test therefore uses its own locale value and
 * its own `UserLocaleStore` signal, and `config` is snapshot-restored below.
 *
 * `detectPreferredLocale` and its CLDR matching are covered in locale.test.ts;
 * this file covers init, the locale subscription, the SSR handoff, and the
 * data-fetching helpers.
 */
const configSnapshot = { ...config };

function okValidate(data: unknown = {}) {
    return vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({ status: true, data });
}

function baseInit(overrides: Record<string, unknown> = {}) {
    return {
        projectid: 'proj-1',
        key: 'key-1',
        UserLocaleStore: createSignal('en-US'),
        ...overrides,
    };
}

beforeEach(() => {
    vi.spyOn(LangsysApp.Translations, 'setup').mockImplementation(() => {});
    vi.spyOn(LangsysApp.Translations, 'change').mockResolvedValue(undefined as never);
    vi.spyOn(LangsysApp.Translations, 'markLoaded').mockImplementation(() => {});
    vi.spyOn(LangsysApp.Translations, 'settle').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(config, configSnapshot);
});

describe('init — configuration guards', () => {
    it('rejects a missing projectid and settles the ready gate', async () => {
        const result = await LangsysApp.init(baseInit({ projectid: '' }) as never);

        expect(result).toEqual({ status: false, errors: ['Missing projectid'] });
        expect(LangsysApp.Translations.settle).toHaveBeenCalled();
    });

    it('rejects a missing key and settles the ready gate', async () => {
        const result = await LangsysApp.init(baseInit({ key: '' }) as never);

        expect(result).toEqual({ status: false, errors: ['Missing API key'] });
        expect(LangsysApp.Translations.settle).toHaveBeenCalled();
    });

    it('rejects a UserLocaleStore that is not a LocaleSource', async () => {
        const result = await LangsysApp.init(baseInit({ UserLocaleStore: 'en-US' }) as never);

        expect(result).toEqual({ status: false, errors: ['Missing UserLocaleStore'] });
        expect(LangsysApp.Translations.settle).toHaveBeenCalled();
    });

    it('rejects a store with get but no subscribe', async () => {
        const result = await LangsysApp.init(
            baseInit({ UserLocaleStore: { get: () => 'en-US' } }) as never,
        );

        expect(result).toEqual({ status: false, errors: ['Missing UserLocaleStore'] });
    });

    it('never calls validate when the config is rejected', async () => {
        const validate = okValidate();

        await LangsysApp.init(baseInit({ projectid: '' }) as never);

        expect(validate).not.toHaveBeenCalled();
    });
});

describe('init — config propagation', () => {
    it('mirrors the accepted config onto the exported singleton', async () => {
        okValidate();

        await LangsysApp.init(baseInit({ projectid: 'proj-9', key: 'key-9' }) as never);

        expect(config.projectid).toBe('proj-9');
        expect(config.key).toBe('key-9');
    });

    it('canonicalizes baseLocale to BCP 47 form', async () => {
        okValidate();

        await LangsysApp.init(baseInit({ baseLocale: 'pt_br' }) as never);

        expect(config.baseLocale).toBe('pt-BR');
    });

    it('defaults baseLocale to en', async () => {
        okValidate();

        await LangsysApp.init(baseInit() as never);

        expect(config.baseLocale).toBe('en');
    });

    it('applies an explicit apiUrl', async () => {
        okValidate();
        const setBaseUrl = vi.spyOn(LangsysAppAPI, 'setBaseUrl').mockImplementation(() => {});

        await LangsysApp.init(baseInit({ apiUrl: 'https://staging.example.test/api' }) as never);

        expect(setBaseUrl).toHaveBeenCalledWith('https://staging.example.test/api');
    });

    it('adopts the key_type reported by validate', async () => {
        okValidate({ key_type: 'write' });

        await LangsysApp.init(baseInit() as never);

        expect(config.key_type).toBe('write');
    });

    it('leaves key_type alone when validate omits it', async () => {
        config.key_type = 'read';
        okValidate({});

        await LangsysApp.init(baseInit() as never);

        expect(config.key_type).toBe('read');
    });

    it('does not overwrite the config when emulateFailureToLoad is set', async () => {
        okValidate();
        config.projectid = 'untouched';

        await LangsysApp.init(baseInit({ projectid: 'proj-x', emulateFailureToLoad: true }) as never);

        expect(config.projectid).toBe('untouched');
    });

    it('settles the ready gate when validate fails', async () => {
        vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({ status: false, errors: ['401'] });

        await LangsysApp.init(baseInit() as never);

        expect(LangsysApp.Translations.settle).toHaveBeenCalled();
    });
});

describe('init — locale subscription', () => {
    it('loads the catalog for the current locale on subscribe', async () => {
        okValidate();

        await LangsysApp.init(baseInit({ UserLocaleStore: createSignal('fr-FR') }) as never);

        expect(LangsysApp.Translations.change).toHaveBeenCalledWith('fr-FR', false);
    });

    it('reloads the catalog when the locale store changes', async () => {
        okValidate();
        const store = createSignal('en-US');
        await LangsysApp.init(baseInit({ UserLocaleStore: store }) as never);

        store.set('ja-JP');

        expect(LangsysApp.Translations.change).toHaveBeenLastCalledWith('ja-JP', false);
    });

    it('canonicalizes whatever the host app puts in the store', async () => {
        okValidate();
        const store = createSignal('en-US');
        await LangsysApp.init(baseInit({ UserLocaleStore: store }) as never);

        store.set('zh_hant_tw');

        expect(LangsysApp.Translations.change).toHaveBeenLastCalledWith('zh-Hant-TW', false);
    });

    it('does not load any catalog when validate failed', async () => {
        vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({ status: false, errors: ['401'] });
        const store = createSignal('en-US');

        await LangsysApp.init(baseInit({ UserLocaleStore: store }) as never);
        store.set('ja-JP');

        expect(LangsysApp.Translations.change).not.toHaveBeenCalled();
    });

    it('exposes the in-flight load as translationsLoadingPromise', async () => {
        okValidate();

        await LangsysApp.init(baseInit() as never);

        await expect(LangsysApp.translationsLoadingPromise).resolves.toBeUndefined();
    });
});

describe('init — SSR handoff', () => {
    const initial = () => ({ nav: { __symbol__: 'nav', Home: 'Inicio' } }) as unknown as iCategories;

    it('seeds the translations store from initialTranslations', async () => {
        okValidate();

        await LangsysApp.init(
            baseInit({ initialTranslations: initial(), initialTranslationsLocale: 'es-ES' }) as never,
        );

        expect(sTranslations.get().nav).toMatchObject({ Home: 'Inicio' });
    });

    it('stamps __category__ onto every provided category', async () => {
        okValidate();

        await LangsysApp.init(
            baseInit({ initialTranslations: initial(), initialTranslationsLocale: 'es-ES' }) as never,
        );

        expect(sTranslations.get().nav.__category__).toBe('nav');
    });

    it('backfills the __uncategorized__ bucket when the host omits it', async () => {
        okValidate();

        await LangsysApp.init(
            baseInit({ initialTranslations: initial(), initialTranslationsLocale: 'es-ES' }) as never,
        );

        expect(sTranslations.get().__uncategorized__).toBeDefined();
    });

    it('records the seeded locale as currently loaded', async () => {
        okValidate();

        await LangsysApp.init(
            baseInit({ initialTranslations: initial(), initialTranslationsLocale: 'es-ES' }) as never,
        );

        expect(currentlyLoadedLocale.get()).toBe('es-ES');
    });

    it('primes the fetch cache so the first settle is a cache hit', async () => {
        okValidate();

        await LangsysApp.init(
            baseInit({ initialTranslations: initial(), initialTranslationsLocale: 'es-ES' }) as never,
        );

        expect(LangsysApp.Translations.markLoaded).toHaveBeenCalledWith('es-ES');
    });

    it('ignores initialTranslations when no locale is given for them', async () => {
        okValidate();

        await LangsysApp.init(baseInit({ initialTranslations: initial() }) as never);

        expect(LangsysApp.Translations.markLoaded).not.toHaveBeenCalled();
    });
});

describe('data helpers — fetching and caching', () => {
    it('fetches countries for the requested locale', async () => {
        const get = vi
            .spyOn(LangsysAppAPI, 'get')
            .mockResolvedValue({ status: true, data: [{ code: 'FR', label: 'France' }] });

        await expect(LangsysApp.getCountries('fr-FR')).resolves.toEqual([{ code: 'FR', label: 'France' }]);
        expect(get).toHaveBeenCalledWith('countries/fr-FR');
    });

    it('serves a second call for the same locale from cache', async () => {
        const get = vi
            .spyOn(LangsysAppAPI, 'get')
            .mockResolvedValue({ status: true, data: [{ code: 'DE', label: 'Deutschland' }] });

        await LangsysApp.getCountries('de-DE');
        await LangsysApp.getCountries('de-DE');

        expect(get).toHaveBeenCalledTimes(1);
    });

    it('refetches when the locale changes', async () => {
        const get = vi
            .spyOn(LangsysAppAPI, 'get')
            .mockResolvedValue({ status: true, data: [{ code: 'IT', label: 'Italia' }] });

        await LangsysApp.getCountries('it-IT');
        await LangsysApp.getCountries('nl-NL');

        expect(get).toHaveBeenCalledTimes(2);
    });

    it('returns an empty list rather than throwing when the request fails', async () => {
        vi.spyOn(LangsysApp.debug, 'error').mockImplementation(() => {});
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: false, errors: ['500'] });

        await expect(LangsysApp.getCountries('sv-SE')).resolves.toEqual([]);
    });

    it('routes currencies and dial codes to their own endpoints', async () => {
        const get = vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: true, data: [] });

        await LangsysApp.getCurrencies('pl-PL');
        await LangsysApp.getDialCodes('pl-PL');

        expect(get).toHaveBeenCalledWith('currencies/pl-PL');
        expect(get).toHaveBeenCalledWith('countries/dial-codes/pl-PL');
    });

    it('appends the format segment for locale data', async () => {
        const get = vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: true, data: [] });

        await LangsysApp.getLocalesFlat('da-DK');

        expect(get).toHaveBeenCalledWith('locales/da-DK/flat');
    });
});

describe('name lookups', () => {
    it('resolves a country name from the loaded list', async () => {
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({
            status: true,
            data: [{ code: 'ES', label: 'España' }],
        });

        await expect(LangsysApp.getCountryName('es', 'es-ES')).resolves.toBe('España');
    });

    it('matches country codes case-insensitively', async () => {
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({
            status: true,
            data: [{ code: 'ES', label: 'España' }],
        });

        await expect(LangsysApp.getCountryName('ES', 'es-MX')).resolves.toBe('España');
    });

    it('falls back to the raw code when nothing matches', async () => {
        vi.spyOn(LangsysApp.debug, 'warn').mockImplementation(() => {});
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: true, data: [] });

        await expect(LangsysApp.getCountryName('ZZ', 'fi-FI')).resolves.toBe('ZZ');
    });

    it('returns an empty string for an empty code without fetching', async () => {
        const get = vi.spyOn(LangsysAppAPI, 'get');

        await expect(LangsysApp.getCountryName('', 'nb-NO')).resolves.toBe('');
        expect(get).not.toHaveBeenCalled();
    });

    it('falls back to the raw code for an unknown currency', async () => {
        vi.spyOn(LangsysApp.debug, 'warn').mockImplementation(() => {});
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: true, data: [] });

        await expect(LangsysApp.getCurrencyName('XYZ', 'ro-RO')).resolves.toBe('XYZ');
    });
});

describe('getLocaleName — synchronous lookup', () => {
    it('warns and returns empty when locale data has not been loaded yet', () => {
        const warn = vi.spyOn(LangsysApp.debug, 'warn').mockImplementation(() => {});

        expect(LangsysApp.getLocaleName('fr-FR', false, 'zz-ZZ')).toBe('');
        expect(warn).toHaveBeenCalled();
    });

    it('returns the locale name once the data is loaded', async () => {
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({
            status: true,
            data: [{ code: 'fr-FR', locale_name: 'français (France)', lang_name: 'français' }],
        });
        await LangsysApp.getLocalesData('hu-HU');

        expect(LangsysApp.getLocaleName('fr-FR', false, 'hu-HU')).toBe('français (France)');
    });

    it('returns the short language name when asked', async () => {
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({
            status: true,
            data: [{ code: 'fr-FR', locale_name: 'français (France)', lang_name: 'français' }],
        });
        await LangsysApp.getLocalesData('cs-CZ');

        expect(LangsysApp.getLocaleName('fr-FR', true, 'cs-CZ')).toBe('français');
    });

    it('returns an empty string for an empty target locale', () => {
        expect(LangsysApp.getLocaleName('', false, 'sk-SK')).toBe('');
    });
});
