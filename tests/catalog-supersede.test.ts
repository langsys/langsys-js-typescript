import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A catalog fetch publishes only while the locale and cache scope it was requested for are still
 * current. A switch while a fetch is in flight supersedes it: the response is dropped when it
 * lands, so the catalog, the loaded locale, the 60s cache-hit stamp and the persisted cache all
 * describe the locale the user is on. The superseded fetch still counts toward its own pair's
 * CACHE-2 window, since the server's answer for that pair is a fact about that pair.
 *
 * Each case is a fresh module graph, so the persisted cache starts empty and its keys are
 * observable through the storage stand-in.
 */

const catalogFor = (phrase: string, value: string) => ({
    status: true,
    write_enabled: true,
    data: { __uncategorized__: { [phrase]: value } },
});
const failed = { status: false, errors: ['HTTP 500: Server Error'], http: { status: 500, statusText: 'Server Error', url: '', data: '' } };

type Answer = { after: number; response?: unknown; throws?: boolean };

let storage: Record<string, string>;

async function page(answers: Record<string, Answer | Answer[]>) {
    vi.resetModules();
    const { LangsysAppAPI } = await import('../src/api.js');
    const stores = await import('../src/stores.js');
    const { Translations } = await import('../src/translations.js');
    const { createSignal } = await import('../src/signal.js');

    const queue: Record<string, Answer[]> = {};
    for (const [locale, answer] of Object.entries(answers)) queue[locale] = Array.isArray(answer) ? [...answer] : [answer];
    const fetches = vi.spyOn(LangsysAppAPI, 'getTranslations').mockImplementation((locale: string) => {
        const next = queue[locale]!.length > 1 ? queue[locale]!.shift()! : queue[locale]![0]!;
        return new Promise((resolve, reject) =>
            setTimeout(() => (next.throws ? reject(new Error('client threw')) : resolve(structuredClone(next.response) as never)), next.after)
        );
    });

    const tr = new Translations({ projectid: 'p1', key: 'k', sUserLocale: createSignal('en-us'), baseLocale: 'en-us' });
    const t = (phrase: string) => tr.tSignal.get()(phrase as never);
    const stored = (locale: string) => storage[`langsys:translations:p1:${locale}`] ?? '';
    return { tr, t, stores, fetches, stored };
}

/** Let every timer and the promise continuations behind it run, up to `ms`. */
async function run(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    storage = {};
    const localStorage = {
        getItem: (k: string) => (k in storage ? storage[k]! : null),
        setItem: (k: string, v: string) => void (storage[k] = v),
        removeItem: (k: string) => void delete storage[k],
    };
    vi.stubGlobal('window', { addEventListener: () => {}, location: { href: 'https://site.local/p' }, localStorage });
    vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('a superseded catalog fetch publishes nothing', () => {
    it('a slow success for the locale left behind does not land over a fast failure', async () => {
        const { tr, t, stores, fetches, stored } = await page({
            'fr-fr': { after: 200, response: catalogFor('Hello', 'Bonjour') },
            'de-de': [
                { after: 0, response: failed },
                { after: 0, response: catalogFor('Hello', 'Hallo') },
            ],
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(400);

        // de failed, so de renders source text (CACHE-2), never the French catalog.
        expect(t('Hello')).toBe('Hello');
        expect(stores.currentlyLoadedLocale.get()).not.toBe('de-de');
        expect(stored('de-de')).not.toContain('Bonjour');
        expect(stores.catalogUnavailable.get()).toBe(true);

        // Nothing stamped de as freshly loaded, so once its window closes de is fetched again.
        await run(3_000);
        void tr.change('de-de');
        await run(10);
        expect(fetches.mock.calls.filter(([locale]) => locale === 'de-de')).toHaveLength(2);
        await run(200);
        expect(t('Hello')).toBe('Hallo');
        expect(stores.currentlyLoadedLocale.get()).toBe('de-de');
    });

    it('two successes landing out of order leave the later request’s catalog in place', async () => {
        const { tr, t, stores, stored } = await page({
            'fr-fr': { after: 200, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(400);

        expect(t('Hello')).toBe('Hallo');
        expect(stores.currentlyLoadedLocale.get()).toBe('de-de');
        expect(stored('de-de')).toContain('Hallo');
        expect(stored('de-de')).not.toContain('Bonjour');
    });

    it('a slow failure for the locale left behind does not mark the current catalog unavailable', async () => {
        const { tr, t, stores } = await page({
            'fr-fr': { after: 200, response: failed },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(400);

        expect(t('Hello')).toBe('Hallo');
        expect(stores.catalogUnavailable.get()).toBe(false);
    });

    it('switching back supersedes the fetch for the locale passed through', async () => {
        const { tr, t, stores, stored } = await page({
            'fr-fr': { after: 200, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 500, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(20);
        void tr.change('fr-fr');
        await run(1_000);

        expect(t('Hello')).toBe('Bonjour');
        expect(stores.currentlyLoadedLocale.get()).toBe('fr-fr');
        expect(stored('fr-fr')).not.toContain('Hallo');
    });

    it('a slow throw for the locale left behind does not mark the current catalog unavailable', async () => {
        const { tr, t, stores } = await page({
            'fr-fr': { after: 200, throws: true },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(400);

        expect(t('Hello')).toBe('Hallo');
        expect(stores.catalogUnavailable.get()).toBe(false);
    });

    it('a re-init for another project supersedes the fetch for the same locale', async () => {
        const { tr, t } = await page({
            'fr-fr': [
                { after: 200, response: catalogFor('Hello', 'Bonjour-P1') },
                { after: 500, response: catalogFor('Hello', 'Bonjour-P2') },
            ],
        });
        const { createSignal } = await import('../src/signal.js');

        void tr.change('fr-fr');
        await run(20);
        tr.setup({ projectid: 'p2', key: 'k', sUserLocale: createSignal('fr-fr'), baseLocale: 'en-us' });
        void tr.change('fr-fr');
        await run(300);

        expect(t('Hello')).not.toBe('Bonjour-P1');
        expect(storage['langsys:translations:p2:fr-fr'] ?? '').not.toContain('Bonjour-P1');

        await run(500);
        expect(t('Hello')).toBe('Bonjour-P2');
    });

    it('the superseded fetch still opens its own pair’s CACHE-2 window', async () => {
        const { tr, fetches } = await page({
            'fr-fr': { after: 200, response: failed },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(400);

        void tr.change('fr-fr');
        await run(10);
        expect(fetches.mock.calls.filter(([locale]) => locale === 'fr-fr')).toHaveLength(1);
    });
});

describe('the loaded locale names the catalog that was published', () => {
    it('a switch inside the 100ms publication delay does not relabel the catalog', async () => {
        const { tr, t, stores } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 500, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(50);
        void tr.change('de-de');
        await run(100);

        // fr was published at 10ms; its locale lands at 110ms, while de is still in flight.
        expect(stores.currentlyLoadedLocale.get()).toBe('fr-fr');

        await run(600);
        expect(t('Hello')).toBe('Hallo');
        expect(stores.currentlyLoadedLocale.get()).toBe('de-de');
    });
});

describe('controls: a fetch that is still current publishes', () => {
    it('switching back to the locale in flight receives its catalog', async () => {
        const { tr, t, stores, fetches } = await page({
            'fr-fr': { after: 200, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 500, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(20);
        void tr.change('de-de');
        await run(20);
        void tr.change('fr-fr');
        await run(300);

        // The second fr joined the first request, which is current again when it lands.
        expect(fetches.mock.calls.filter(([locale]) => locale === 'fr-fr')).toHaveLength(1);
        expect(t('Hello')).toBe('Bonjour');
        expect(stores.currentlyLoadedLocale.get()).toBe('fr-fr');
    });

    it('sequential switches each publish', async () => {
        const { tr, t, stores, stored } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(200);
        expect(t('Hello')).toBe('Bonjour');
        expect(stored('fr-fr')).toContain('Bonjour');

        void tr.change('de-de');
        await run(200);
        expect(t('Hello')).toBe('Hallo');
        expect(stores.currentlyLoadedLocale.get()).toBe('de-de');
        expect(stored('de-de')).toContain('Hallo');
    });
});

describe('a pair’s cache key holds only a published catalog (CACHE-2)', () => {
    /**
     * Switching to a locale with nothing cached resets the page catalog to the empty skeleton,
     * so the previous locale's text is not shown under the new one. That reset is not a
     * catalog: a fetch, a seed or a snapshot produces one. Persisted, it would sit under the
     * pair's key after the fetch failed or was superseded, and the next load's restore would
     * adopt it as that pair's catalog.
     */
    const key = (locale: string) => `langsys:translations:p1:${locale}`;

    it('a switch whose fetch fails leaves no key for that pair', async () => {
        const { tr } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 10, response: failed },
        });

        void tr.change('fr-fr');
        await run(200);
        void tr.change('de-de');
        await run(200);

        expect(storage[key('fr-fr')]).toContain('Bonjour');
        expect(storage).not.toHaveProperty(key('de-de'));
    });

    it('a switch whose fetch is superseded leaves no key for that pair', async () => {
        const { tr } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 500, response: catalogFor('Hello', 'Hallo') },
            'es-es': { after: 10, response: catalogFor('Hello', 'Hola') },
        });

        void tr.change('fr-fr');
        await run(200);
        void tr.change('de-de');
        await run(20);
        void tr.change('es-es');
        await run(1_000);

        expect(storage[key('es-es')]).toContain('Hola');
        expect(storage).not.toHaveProperty(key('de-de'));
    });

    it('a successful fetch still persists its catalog under its pair', async () => {
        const { tr } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 10, response: catalogFor('Hello', 'Hallo') },
        });

        void tr.change('fr-fr');
        await run(200);
        void tr.change('de-de');
        await run(200);

        expect(storage[key('de-de')]).toContain('Hallo');
    });

    it('control: a catalog stored for that pair earlier is untouched by a later failure, and keeps serving', async () => {
        storage[key('de-de')] = JSON.stringify({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__', Hello: 'Hallo-STORED' } });
        const before = storage[key('de-de')];
        const { tr, t } = await page({
            'fr-fr': { after: 10, response: catalogFor('Hello', 'Bonjour') },
            'de-de': { after: 10, response: failed },
        });

        void tr.change('fr-fr');
        await run(200);
        void tr.change('de-de');
        await run(200);

        expect(storage[key('de-de')]).toBe(before);
        expect(t('Hello')).toBe('Hallo-STORED');
    });
});
