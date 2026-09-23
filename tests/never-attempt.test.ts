import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { createSignal } from '../src/signal.js';
import { catalogUnavailable, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * "Never attempt to register when write_enabled is false" (REG-1, and GATE-6's second
 * sentence), proven at the transport seam — `n/a (pure)`.
 *
 * The contract double cannot grade this, by design: a write it refuses and a write that was
 * never sent leave the same accepted state. The property is the client's own decision not to
 * transmit, so it is observed where the client would transmit: the API client's registration
 * call. Proven on every path that can detect unregistered content — a `t()` miss and a content
 * block — each with a control showing the same session registers once it may.
 */

let register: ReturnType<typeof vi.spyOn>;
const live: Translations[] = [];

function session(): Translations {
    const tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
    live.push(tr);
    return tr;
}
const t = (tr: Translations) => tr.tSignal.get() as unknown as (phrase: string, category: string) => string;
const block = { custom_id: 'b1', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };

beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    const store = new Map<string, string>();
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' }, sessionStorage: g.sessionStorage };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    _resetDiscoveryState();
    catalogUnavailable.set(false);
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    register = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true } as never);
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
});

afterEach(() => {
    for (const tr of live) tr.destroy();
    live.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetDiscoveryState();
    writeEnabled.set(undefined);
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
});

describe('a session the server judged read-only never attempts to register', () => {
    it('t() path: misses are not sent, however long the session runs', async () => {
        writeEnabled.set(false);
        const tr = session();
        t(tr)('Brand new', 'UI');
        t(tr)('Also new', 'UI');
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(register).not.toHaveBeenCalled();
    });

    it('control, t() path: the same misses are sent once the session may write', async () => {
        writeEnabled.set(true);
        const tr = session();
        t(tr)('Brand new', 'UI');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('content-block path: the block is not sent', async () => {
        writeEnabled.set(false);
        await registerContentBlock(block as never);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(register).not.toHaveBeenCalled();
    });

    it('control, content-block path: the same block is sent once the session may write', async () => {
        writeEnabled.set(true);
        await registerContentBlock(block as never);
        expect(register).toHaveBeenCalledTimes(1);
    });
});
