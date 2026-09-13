import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { createSignal } from '../src/signal.js';
import { catalogUnavailable, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * REG-12: a content block is recognised by its structure, never by the shape of its id.
 *
 * A catalog value that is a nested map is a block; a string or null is a phrase. The
 * core also used to refuse, before queueing, any phrase matching `/^[0-9a-f]{32}$/`, on
 * the theory that a block id might reach `t()`. None does: `t()` is called with
 * `<Phrase>` text and `<Translate>` tokens, custom ids go only to `lookupContent`, and
 * no binding or JS Server hands one to `t()` (searched). With the structure already in
 * hand the shape test could only be wrong, and it was: a legitimate phrase that happens
 * to be 32 lowercase hex digits, such as an order reference shown to a user, was never
 * registered.
 *
 * "Presence and structure agree on both paths": `t()` decides known by key presence,
 * and the flush deduplicates by key presence, so text colliding with a stored block id
 * is known on both and never re-registers.
 */

const g = globalThis as unknown as Record<string, unknown>;
const HASH_PHRASE = '0123456789abcdef0123456789abcdef';
const BLOCK_ID = 'fedcba9876543210fedcba9876543210';

let posted: string[] = [];
const live: Translations[] = [];
const queueOf = (t: Translations) => (t as unknown as { missingTokens: Array<{ token: string }> }).missingTokens.map((m) => m.token);
const tOf = (t: Translations) => t.tSignal.get() as unknown as (phrase: string, category?: string) => string;

function make(): Translations {
    const t = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
    live.push(t);
    return t;
}

function seedUI(entries: Record<string, unknown>) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
}

beforeEach(() => {
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    g.sessionStorage = { getItem: () => null, setItem: () => {} };
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    writeEnabled.set(true);
    seedUI({});
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
    _resetDiscoveryState();
    writeEnabled.set(undefined);
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('REG-12: blocks are told apart by structure, not by id shape', () => {
    it('a phrase that looks like a 32-hex id, absent from the catalog, is queued and registered', async () => {
        const tr = make();
        expect(tOf(tr)(HASH_PHRASE, 'UI')).toBe(HASH_PHRASE);
        expect(queueOf(tr)).toEqual([HASH_PHRASE]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toEqual([HASH_PHRASE]);
    });

    it('a hash-shaped phrase with a stored translation renders it', () => {
        seedUI({ [HASH_PHRASE]: 'Referencia' });
        expect(tOf(make())(HASH_PHRASE, 'UI')).toBe('Referencia');
    });

    it('text colliding with a stored block id is known on the t() path: source text, nothing queued or sent', async () => {
        seedUI({ [BLOCK_ID]: { 'Phrase A': null } });
        const tr = make();
        expect(tOf(tr)(BLOCK_ID, 'UI')).toBe(BLOCK_ID);
        expect(queueOf(tr)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toEqual([]);
    });

    it('and on the flush path: a queued token whose key now holds a block is dropped by the dedup, not sent', async () => {
        const tr = make();
        tOf(tr)(BLOCK_ID, 'UI');
        expect(queueOf(tr), 'queued while the key was absent').toEqual([BLOCK_ID]);
        seedUI({ [BLOCK_ID]: { 'Phrase A': null } });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toEqual([]);
    });
});
