import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { setPersistStorage, type PersistStorage } from '../src/persist.js';
import { createSignal } from '../src/signal.js';
import { autoDiscovery, catalogUnavailable, currentlyLoadedLocale, discoveryBaseLocaleOnly, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * The base-locale gate: while it is on, a miss is recorded only when the loaded locale
 * IS the base locale.
 *
 * Why it exists, measured by the Laravel lane and verified here: the catalog is keyed by
 * source text, and a server SDK renders a page in the visitor's language. Every string in
 * that page is a translation. A write-enabled session browsing in Spanish therefore filed
 * Spanish sentences as new SOURCE phrases, and a read-only one sent a discovery hint for a
 * localized URL, which points the renderer at the same translated text. Legacy servers
 * already send translated text and cannot be made to stop.
 *
 * It is a PROJECT setting delivered in the handshake, not a client option: authorize `data`
 * beside `key_type`, and the catalog envelope beside `words`. One source of truth, no local
 * override, and absent means off — which is also the state until the field is on the wire.
 *
 * The trade-off, and the reason it defaults to off: with it on, an English fallback
 * appearing on a localized page is no longer discovered from that page.
 */

const g = globalThis as unknown as Record<string, unknown>;
const NEW_PHRASE = 'Genuinely new phrase';
const ok = (body: unknown) => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    url: 'https://api.local/x',
    headers: { get: () => null },
    json: async () => body,
});

let posted: string[] = [];
let hinted: string[] = [];
let writes: Array<[string, string]> = [];
const live: Translations[] = [];
const storage: PersistStorage = { getItem: () => null, setItem: (k, v) => void writes.push([k, String(v)]), removeItem: () => {} };
const queueOf = (t: Translations) => (t as unknown as { missingTokens: Array<{ token: string }> }).missingTokens.map((m) => m.token);
const tOf = (t: Translations) => t.tSignal.get() as unknown as (phrase: string, category?: string) => string;

function make(): Translations {
    const t = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' });
    live.push(t);
    return t;
}

/** A catalog envelope, with the gate field present only when asked for. */
const envelope = (gate?: boolean, writeEnabledValue = true) => ({
    status: true,
    write_enabled: writeEnabledValue,
    words: 12,
    ...(gate === undefined ? {} : { discovery_base_locale_only: gate }),
    data: { UI: { Hola: 'Hola' } },
});

beforeEach(() => {
    const session = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) };
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/es/pagina' }, sessionStorage: g.sessionStorage };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    discoveryBaseLocaleOnly.set(false);
    writeEnabled.set(undefined);
    autoDiscovery.set(true);
    currentlyLoadedLocale.set('');
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    posted = [];
    hinted = [];
    writes = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockImplementation(async (url: string) => {
        hinted.push(url);
        return { status: true };
    });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
});

afterEach(() => {
    for (const t of live) t.destroy();
    live.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setPersistStorage(null);
    _resetDiscoveryState();
    discoveryBaseLocaleOnly.set(false);
    writeEnabled.set(undefined);
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('the gate arrives on the wire, from either handshake', () => {
    it('the catalog envelope carries it', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(true))));
        await make().change('es-es');
        expect(discoveryBaseLocaleOnly.get()).toBe(true);
    });

    it('the authorize body carries it too, so a read-only session gets it before any catalog', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (String(url).includes('authorize-project')) {
                    return ok({ status: true, data: { key_type: 'read', write_enabled: false, discovery_base_locale_only: true } });
                }
                return ok({ status: true, data: { UI: {} } });
            })
        );
        await LangsysApp.init({ projectid: 'p', key: 'k', UserLocaleStore: createSignal('es-es'), baseLocale: 'en' });
        live.push(LangsysApp.Translations);
        expect(discoveryBaseLocaleOnly.get()).toBe(true);
    });

    it('the module default is off, before any handshake has been read', async () => {
        // Asserted on a FRESH module instance: every other test resets the store in
        // `beforeEach`, which masks the default — a build that shipped it as `true` went
        // green through the whole file until this case existed.
        vi.resetModules();
        const fresh = await import('../src/stores.js');
        expect(fresh.discoveryBaseLocaleOnly.get()).toBe(false);
    });

    it('absent means off, and no client setting can turn it on', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(undefined))));
        await make().change('es-es');
        expect(discoveryBaseLocaleOnly.get()).toBe(false);
    });

    it('is never written to a cached artifact', async () => {
        setPersistStorage(storage);
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(true))));
        await make().change('es-es');
        expect(writes.filter(([k, v]) => k.includes('discovery_base_locale_only') || v.includes('discovery_base_locale_only'))).toEqual([]);
        expect(writes.some(([k, v]) => k.startsWith('langsys:translations:') && v.includes('Hola')), 'control: the catalog did reach storage').toBe(true);
    });
});

describe('with the gate on, a non-base locale records nothing on either lane', () => {
    it('the write lane queues and sends nothing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(true))));
        const tr = make();
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(200);
        tOf(tr)(NEW_PHRASE, 'UI');
        expect(queueOf(tr)).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([]);
    });

    it('the read lane reports nothing, so the renderer is not sent to a localized URL', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(true, false))));
        const tr = make();
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(200);
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toEqual([]);
    });

    it('control: the same miss AT the base locale still registers', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(true))));
        const tr = make();
        await tr.change('en');
        await vi.advanceTimersByTimeAsync(200);
        tOf(tr)(NEW_PHRASE, 'UI');
        expect(queueOf(tr)).toEqual([NEW_PHRASE]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([NEW_PHRASE]);
    });

    it('control: with the gate off, the same miss in the same locale registers', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(false))));
        const tr = make();
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(200);
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([NEW_PHRASE]);
    });

    it('control: with the gate off, the read lane still reports', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ok(envelope(false, false))));
        const tr = make();
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(200);
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toEqual(['https://site.local/es/pagina']);
    });
});
