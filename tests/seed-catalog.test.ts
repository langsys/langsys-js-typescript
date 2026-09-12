import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import type { iCategories } from '../src/types/translations.js';

/**
 * `seedCatalog` — the hydration hand-off primitive.
 *
 * A framework's client entry calls it with the catalog the server already
 * rendered from, before mount, so the first paint carries translations instead
 * of source text. The value of it is entirely in being SYNCHRONOUS: a promise
 * would land after the first paint, which is the problem it exists to solve.
 */

function catalog(): iCategories {
    return {
        Marketing: { __category__: 'Marketing', __symbol__: 'Marketing', Pricing: 'Precios' } as never,
    } as iCategories;
}

function bare(): iCategories {
    return { __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as iCategories;
}

beforeEach(() => {
    sTranslations.set(bare());
    currentlyLoadedLocale.set('');
});

afterEach(() => vi.restoreAllMocks());

describe('a seeded catalog is readable on the next line', () => {
    it('t() returns the translation synchronously, with no await anywhere', () => {
        LangsysApp.seedCatalog(catalog(), 'es-es');

        // No await. If `seedCatalog` ever returns a promise or defers a write,
        // this line reads the source text and the test fails — which is the
        // only property that makes it useful to a client entry.
        expect(LangsysApp.t('Pricing', 'Marketing')).toBe('Precios');
    });

    it('publishes the locale in canonical form', () => {
        LangsysApp.seedCatalog(catalog(), 'ES-es');
        expect(currentlyLoadedLocale.get()).toBe('es-es');
    });

    it('injects __uncategorized__ and stamps every __category__', () => {
        const c = { Marketing: { Pricing: 'Precios' } } as unknown as iCategories;
        LangsysApp.seedCatalog(c, 'es-es');

        const live = sTranslations.get();
        expect(live['__uncategorized__']).toBeDefined();
        expect(live['Marketing']?.['__category__']).toBe('Marketing');
    });

    it('returns undefined, not a promise — the signature is the contract', () => {
        // A caller that can `await` this would be encouraged to, and a future
        // async rewrite would then look compatible while breaking first paint.
        expect(LangsysApp.seedCatalog(catalog(), 'es-es')).toBeUndefined();
    });
});

describe('control: without the seed, the problem is visible', () => {
    // SRV-4's test shape requires this half. "Seeded renders the translation"
    // passes against a harness that would render the translation anyway — the
    // claim only means something if the UNSEEDED case demonstrably does not.
    //
    // The spec's own version pairs it with a hydration-mismatch warning, which
    // is framework-level and cannot be produced here: the core has no renderer
    // to mismatch. The core-level equivalent is that `t()` falls back to source
    // text, and the bindings carry the warning half.
    it('t() returns the source text when nothing was seeded', () => {
        sTranslations.set(bare());
        currentlyLoadedLocale.set('es-es');

        expect(LangsysApp.t('Pricing', 'Marketing')).toBe('Pricing');
    });

    it('and the seed is what changes it, on the same phrase and category', () => {
        sTranslations.set(bare());
        currentlyLoadedLocale.set('es-es');
        const before = LangsysApp.t('Pricing', 'Marketing');

        LangsysApp.seedCatalog(catalog(), 'es-es');
        const after = LangsysApp.t('Pricing', 'Marketing');

        expect(before).toBe('Pricing');
        expect(after).toBe('Precios');
    });
});

describe('init() does not clobber a seeded catalog', () => {
    it('keeps the seeded catalog while still authorizing', async () => {
        const seen: string[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            seen.push(String(url));
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                url: '',
                headers: { get: () => 'application/json' },
                json: async () => ({ status: true, data: { key_type: 'read', write_enabled: false } }),
            } as unknown as Response;
        });

        LangsysApp.seedCatalog(catalog(), 'es-es');

        const res = await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('es-es'),
            baseLocale: 'es',
            initialTranslations: bare(),
            initialTranslationsLocale: 'es-es',
        });

        // Validation still ran — seeding is not a way to skip authorization.
        expect(res.status).toBe(true);
        expect(seen.some((u) => u.includes('authorize-project'))).toBe(true);

        // And the seeded catalog survived the empty payload passed via config.
        expect(LangsysApp.t('Pricing', 'Marketing')).toBe('Precios');
    });

    it('leaves the write gate alone — seeding grants no capability', async () => {
        vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({ status: false, errors: ['nope'] });
        LangsysApp.seedCatalog(catalog(), 'es-es');

        await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('es-es'),
            baseLocale: 'es',
        });

        // A failed authorization must still leave the session unable to write,
        // no matter how much catalog is present.
        const { writeEnabled } = await import('../src/stores.js');
        expect(writeEnabled.get()).not.toBe(true);
    });

    it('still seeds when nothing was seeded beforehand', async () => {
        // Control: the guard must not have turned the config hand-off into a
        // no-op for everyone who relies on it.
        vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({ status: false, errors: ['offline'] });

        await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('es-es'),
            baseLocale: 'es',
            initialTranslations: catalog(),
            initialTranslationsLocale: 'es-es',
        });

        expect(LangsysApp.t('Pricing', 'Marketing')).toBe('Precios');
    });
});
