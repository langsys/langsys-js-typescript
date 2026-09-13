import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { setPersistStorage, type PersistStorage } from '../src/persist.js';
import { createSignal } from '../src/signal.js';
import { writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * GATE-4: strip the write decision from whatever is about to be cached.
 *
 * The flag sits in a different place on each endpoint, and that difference is the
 * rule. On `/translations` it is on the envelope, beside `data`. On
 * `/authorize-project/{project}` it is INSIDE `data`. An SDK that caches "only
 * `data`" is right on the first route and wrong on the second, which is how the PHP
 * SDK came to hold the decision in a one-hour file cache.
 *
 * This SDK caches one artifact, the catalog, and never the authorize body. Each test
 * records every storage write made while the response is handled and checks that
 * `write_enabled` is in none of them. Two positive controls keep that from passing
 * vacuously: the catalog DID reach storage, so the recorder is live; and the decision
 * WAS read, so the field really was in the response being handled.
 */

const g = globalThis as unknown as Record<string, unknown>;
let writes: Array<[string, string]> = [];
const storage: PersistStorage = {
    getItem: () => null,
    setItem: (k, v) => void writes.push([k, String(v)]),
    removeItem: () => {},
};
const leaks = () => writes.filter(([k, v]) => k.includes('write_enabled') || v.includes('write_enabled'));
const cachedCatalog = () => writes.filter(([k, v]) => k.startsWith('langsys:translations:') && v.includes('Hola'));

const ok = (body: unknown) => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    url: 'https://api.local/x',
    headers: { get: () => null },
    json: async () => body,
});
const live: Translations[] = [];

beforeEach(() => {
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    g.sessionStorage = { getItem: () => null, setItem: () => {} };
    writeEnabled.set(undefined);
    writes = [];
    setPersistStorage(storage);
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    for (const t of live) t.destroy();
    live.length = 0;
    setPersistStorage(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    writeEnabled.set(undefined);
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('GATE-4 on /translations: the flag is on the envelope, and only the body is cached', () => {
    it('caches the catalog without the decision', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok({ status: true, write_enabled: true, data: { UI: { Hello: 'Hola' } } })));
        const tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
        live.push(tr);
        await tr.change('es-es');

        expect(writeEnabled.get(), 'control: the decision was read off the envelope').toBe(true);
        expect(cachedCatalog().length, 'control: the catalog reached storage').toBeGreaterThan(0);
        expect(leaks()).toEqual([]);
    });

    it('a flag misplaced inside data is not cached either', async () => {
        // A legacy or confused server answering with the flag among the categories.
        vi.stubGlobal('fetch', vi.fn(async () => ok({ status: true, data: { write_enabled: true, UI: { Hello: 'Hola' } } })));
        const tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
        live.push(tr);
        await tr.change('es-es', true);

        expect(cachedCatalog().length, 'control: the catalog reached storage').toBeGreaterThan(0);
        expect(leaks()).toEqual([]);
    });
});

describe('GATE-4 on /authorize-project: the flag is inside data, and the body is never cached', () => {
    it('init reads the decision from the authorize body and writes it to no storage', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (String(url).includes('authorize-project')) return ok({ status: true, data: { key_type: 'write', write_enabled: true } });
            // No flag on this catalog envelope, so a true decision can only have come
            // from the authorize body.
            if (String(url).includes('translations')) return ok({ status: true, data: { UI: { Hello: 'Hola' } } });
            return ok({ status: true, data: [] });
        });
        vi.stubGlobal('fetch', fetchMock);

        await LangsysApp.init({ projectid: 'p', key: 'k', UserLocaleStore: createSignal('es-es'), baseLocale: 'en' });
        live.push(LangsysApp.Translations);
        await vi.waitFor(() => expect(cachedCatalog().length, 'control: the catalog reached storage').toBeGreaterThan(0));

        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('authorize-project')), 'control: authorize was called').toBe(true);
        expect(writeEnabled.get(), 'control: the decision was read from inside the authorize body').toBe(true);
        expect(leaks()).toEqual([]);
    });
});
