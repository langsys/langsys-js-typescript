import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { createSignal } from '../src/signal.js';
import { catalogUnavailable, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * A registration flush waits for a catalog fetch that is still in flight.
 *
 * Measured before the hold existed, with write capability already granted: a miss
 * recorded during a cold visit was flushed after the 400ms debounce and deduplicated
 * against a catalog that had not arrived, so a phrase the backend already held was
 * POSTed whenever the fetch took 1s or 5s (not at 300ms). No spec rule names the case.
 * It is WIRE-4's reason, that without a catalog a miss cannot be told from a hit,
 * applied to a catalog that is late rather than failed. A locale switch has the same
 * window, because the new scope starts empty.
 */

const g = globalThis as unknown as Record<string, unknown>;
const PHRASE = 'Already registered phrase';
const NEW_PHRASE = 'Genuinely new phrase';
const catalog = (entries: Record<string, string>) => ({ status: true, write_enabled: true, data: { UI: entries } });
const ok = (body: unknown) => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    url: 'https://api.local/x',
    headers: { get: () => null },
    json: async () => body,
});

let posted: string[] = [];
const live: Translations[] = [];
const tOf = (t: Translations) => t.tSignal.get() as unknown as (phrase: string, category?: string) => string;

function make(): Translations {
    const t = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
    live.push(t);
    return t;
}

/** A fetch the test answers by hand: each call waits until `answer()` releases it. */
function deferredFetch() {
    const waiting: Array<(value: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => waiting.push(resolve))));
    return {
        async answer(body: unknown) {
            for (let i = 0; i < 50 && waiting.length === 0; i++) await Promise.resolve();
            const next = waiting.shift();
            if (!next) throw new Error('no catalog fetch was waiting');
            next(ok(body));
        },
    };
}

beforeEach(() => {
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    g.sessionStorage = { getItem: () => null, setItem: () => {} };
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    writeEnabled.set(undefined);
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    posted = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
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
    _resetDiscoveryState();
    writeEnabled.set(undefined);
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('a registration flush waits for the catalog in flight', () => {
    it('a cold visit sends nothing before its first catalog arrives, however long that takes', async () => {
        writeEnabled.set(true);
        const net = deferredFetch();
        const tr = make();
        const loading = tr.change('es-es');
        tOf(tr)(PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([]);

        await net.answer(catalog({ [PHRASE]: 'Frase ya registrada' }));
        await loading;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted, 'deduplicated once the catalog arrived').toEqual([]);
    });

    it('on arrival the held flush runs before the backstop would, and sends only the genuine miss', async () => {
        writeEnabled.set(true);
        const net = deferredFetch();
        const tr = make();
        const loading = tr.change('es-es');
        tOf(tr)(PHRASE, 'UI');
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(2_000);
        expect(posted).toEqual([]);

        await net.answer(catalog({ [PHRASE]: 'Frase ya registrada' }));
        await loading;
        // 2.6s in total, short of the 3s backstop tick: only arrival can have flushed.
        await vi.advanceTimersByTimeAsync(600);
        expect(posted).toEqual([NEW_PHRASE]);
    });

    it('a locale switch in flight holds the flush too', async () => {
        writeEnabled.set(true);
        const net = deferredFetch();
        const tr = make();
        const first = tr.change('es-es');
        await net.answer(catalog({ [PHRASE]: 'Frase ya registrada' }));
        await first;

        const switching = tr.change('fr-fr');
        tOf(tr)(PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([]);

        await net.answer(catalog({ [PHRASE]: 'Phrase deja enregistree' }));
        await switching;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([]);
    });

    it('control: with no fetch in flight, a genuine miss is still sent after the debounce', async () => {
        writeEnabled.set(true);
        const net = deferredFetch();
        const tr = make();
        const loading = tr.change('es-es');
        await net.answer(catalog({ [PHRASE]: 'Frase ya registrada' }));
        await loading;

        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(600);
        expect(posted).toEqual([NEW_PHRASE]);
    });
});
