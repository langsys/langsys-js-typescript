import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { createSignal } from '../src/signal.js';
import { autoDiscovery, catalogUnavailable, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * WIRE-4: the translation call never throws, and a failed catalog fetch queues no
 * registrations.
 *
 * Both shapes pinned below were measured as violations before the fix, with write
 * capability already granted. A network-failed fetch let `t()` misses queue and POST
 * phrases that were already registered. A failed locale switch did the same, because
 * the new scope had just reset the catalog to empty. That turns an API outage into a
 * write storm, on exactly the paths that were already failing.
 *
 * "Unreachable" is simulated at `fetch`, beneath the API client, so the client's own
 * error handling is part of what runs. The one exception replaces the client method,
 * to show `change()` cannot reject even when the client throws.
 */

const g = globalThis as unknown as Record<string, unknown>;
const PHRASE = 'Already registered phrase';
const NEW_PHRASE = 'Genuinely new phrase';
const CATALOG = { status: true, write_enabled: true, data: { UI: { [PHRASE]: 'Frase ya registrada' } } };

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
const live: Translations[] = [];
const queueOf = (t: Translations) => (t as unknown as { missingTokens: Array<{ token: string }> }).missingTokens.map((m) => m.token);
const tOf = (t: Translations) => t.tSignal.get() as unknown as (phrase: string, category?: string) => string;

function make(): Translations {
    const t = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
    live.push(t);
    return t;
}

/** The API is down until `recover()`, and down again after `fail()`. */
function outage(body: unknown = CATALOG) {
    let down = true;
    vi.stubGlobal('fetch', vi.fn(async () => (down ? Promise.reject(new TypeError('fetch failed')) : ok(body))));
    return { recover: () => void (down = false), fail: () => void (down = true) };
}

beforeEach(() => {
    const session = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v) };
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' }, sessionStorage: g.sessionStorage };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    writeEnabled.set(undefined);
    autoDiscovery.set(true);
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    posted = [];
    hinted = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase ?? item.custom_id));
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
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    writeEnabled.set(undefined);
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('WIRE-4: an unreachable API is an expected condition', () => {
    it('neither the catalog fetch nor t() throws, and t() degrades to source text', async () => {
        outage();
        const tr = make();
        await expect(tr.change('es-es')).resolves.toBe(true);
        expect(() => tOf(tr)(PHRASE, 'UI')).not.toThrow();
        expect(tOf(tr)(PHRASE, 'UI')).toBe(PHRASE);
    });

    it('a client that throws, instead of answering with an error, does not reject change() either', async () => {
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockRejectedValue(new Error('client threw'));
        const tr = make();
        await expect(tr.change('es-es')).resolves.toBe(true);
        expect(tOf(tr)(PHRASE, 'UI')).toBe(PHRASE);
    });
});

describe('WIRE-4: a failed catalog fetch queues no registrations', () => {
    it('shape 1: the fetch fails with misses present, and nothing is queued or sent despite write capability', async () => {
        writeEnabled.set(true);
        outage();
        const tr = make();
        await tr.change('es-es');
        tOf(tr)(PHRASE, 'UI');
        tOf(tr)(NEW_PHRASE, 'UI');
        expect(queueOf(tr)).toEqual([]);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(posted).toEqual([]);
    });

    it('shape 2: a locale switch that fails mid-scope does not re-register what the previous catalog held', async () => {
        writeEnabled.set(true);
        const net = outage();
        net.recover();
        const tr = make();
        await tr.change('es-es');
        expect(tOf(tr)(PHRASE, 'UI'), 'control: known under the first scope').toBe('Frase ya registrada');

        net.fail();
        await tr.change('fr-fr');
        expect(tOf(tr)(PHRASE, 'UI')).toBe(PHRASE);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(posted).toEqual([]);
    });

    it('a miss recorded before the fetch settled is held, not sent, once the fetch fails', async () => {
        writeEnabled.set(true);
        outage();
        const tr = make();
        tOf(tr)(PHRASE, 'UI');
        expect(queueOf(tr), 'control: a miss before the catalog settles is held, by design').toEqual([PHRASE]);
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(posted).toEqual([]);
        expect(queueOf(tr), 'held, not dropped').toEqual([PHRASE]);
    });

    it('recovery lifts the hold: the held miss is deduplicated against the real catalog, and a genuine miss registers', async () => {
        writeEnabled.set(true);
        const net = outage();
        const tr = make();
        tOf(tr)(PHRASE, 'UI');
        await tr.change('es-es');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(posted, 'nothing leaves during the outage').toEqual([]);

        net.recover();
        await tr.change('es-es', true);
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(15_000);
        expect(posted).toEqual([NEW_PHRASE]);
    });

    it('records no discovery miss either: a read-only session reports nothing during the outage', async () => {
        writeEnabled.set(false);
        const net = outage({ status: true, write_enabled: false, data: { UI: {} } });
        const tr = make();
        await tr.change('es-es');
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toEqual([]);

        // Control: the same miss after recovery does report, so the silence was the gate.
        net.recover();
        await tr.change('es-es', true);
        tOf(tr)(NEW_PHRASE, 'UI');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toEqual(['https://site.local/p']);
    });

    it('a content block seen during the outage is not registered', async () => {
        writeEnabled.set(true);
        const net = outage({ status: true, write_enabled: true, data: { UI: {} } });
        const tr = make();
        await tr.change('es-es');
        const block = { custom_id: 'b'.repeat(32), category: 'UI', content: '<p>A</p>', tokens: ['A'] };
        await expect(registerContentBlock(block as never)).resolves.toEqual({ status: true });
        expect(posted).toEqual([]);

        net.recover();
        await tr.change('es-es', true);
        await registerContentBlock(block as never);
        expect(posted, 'control: registers once the catalog is back').toEqual([block.custom_id]);
    });
});
