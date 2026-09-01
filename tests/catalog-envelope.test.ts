import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';
import { sTranslations } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * A `/translations` payload whose `data` carries non-category members.
 *
 * `data` IS the category map on that route, so every member gets stamped with
 * `__category__`. A legacy envelope answering with `key_type` / `auto_discovery`
 * siblings therefore threw `Cannot create property '__category__' on string`,
 * inside an un-awaited `change()` — an unhandled rejection that took down the
 * caller's tick rather than degrading.
 *
 * It also made `npm test` exit 1 while every test reported passing, which is
 * how it survived several rounds of "gates clean": the coverage was incidental,
 * resting on the exit code of an unrelated mock. Hence a NAMED test.
 */

function newTranslations() {
    return new Translations({
        projectid: 'p',
        key: 'k',
        sUserLocale: createSignal('en-us'),
        baseLocale: 'en',
        debug: true,
    });
}

let warn: ReturnType<typeof vi.spyOn>;
const said = () => warn.mock.calls.flat().map(String).join(' ');

beforeEach(() => {
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('a legacy envelope with scalar members inside data', () => {
    it('resolves instead of throwing, and loads the valid category', async () => {
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: {
                key_type: 'read',
                auto_discovery: false,
                UI: { Hello: 'Hola' },
            } as unknown as object,
        });

        const tr = newTranslations();
        await expect(tr.change('es-es')).resolves.toBe(true);

        expect(sTranslations.get()['UI']?.['Hello']).toBe('Hola');
    });

    it('names each offending member rather than failing anonymously', async () => {
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: { key_type: 'read', auto_discovery: false, UI: { Hello: 'Hola' } } as unknown as object,
        });

        await newTranslations().change('es-es');

        expect(said()).toContain('key_type');
        expect(said()).toContain('auto_discovery');
    });

    it('drops the scalars from the catalog rather than keeping them as categories', async () => {
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: { key_type: 'read', UI: { Hello: 'Hola' } } as unknown as object,
        });

        await newTranslations().change('es-es');

        expect(sTranslations.get()['key_type']).toBeUndefined();
    });

    it('handles an ARRAY member too, which stamps just as badly', async () => {
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: { errors: ['nope'], UI: { Hello: 'Hola' } } as unknown as object,
        });

        const tr = newTranslations();
        await expect(tr.change('es-es')).resolves.toBe(true);
        expect(said()).toContain('an array');
    });

    it('control: an ordinary payload loads with no warning at all', async () => {
        // Without this the assertions above could pass under an implementation
        // that warned about everything.
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: { UI: { Hello: 'Hola' } } as unknown as object,
        });

        await newTranslations().change('es-es');

        expect(sTranslations.get()['UI']?.['Hello']).toBe('Hola');
        expect(said()).not.toContain('non-category');
    });
});
