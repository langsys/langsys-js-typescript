import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';
import { catalogUnavailable, sTranslations } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * CACHE-2's in-process half, proven at the transport seam (`n/a (pure)`).
 *
 * The rendered consequence of the window — source text inside it, the translation after it —
 * is graded against the contract double in `contract-write-lane`. What the double cannot see is
 * how many requests were made, because a catalog read changes no server state. That is proven
 * here, by counting calls into the API client: concurrent fetches share one request, the window
 * doubles and caps, the first success clears it, and an explicit refresh still goes out.
 */

const failed = { status: false, errors: ['HTTP 500: Server Error'], http: { status: 500, statusText: 'Server Error', url: '', data: '' } };
const ok = { status: true, write_enabled: true, data: { UI: { Known: 'Conocido' } } };
let fetches: ReturnType<typeof vi.spyOn>;

function make(): Translations {
    return new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
}

beforeEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    catalogUnavailable.set(false);
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    fetches = vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue(failed as never);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    catalogUnavailable.set(false);
});

describe('CACHE-2: concurrent fetches for the same pair share one request', () => {
    it('two fetches started together make one request', async () => {
        let release!: (v: unknown) => void;
        fetches.mockImplementation(() => new Promise((r) => (release = r)) as never);
        const tr = make();
        const a = tr.change('es-es');
        const b = tr.change('es-es');
        await Promise.resolve();
        release(ok);
        await Promise.all([a, b]);
        expect(fetches).toHaveBeenCalledTimes(1);
    });

    it('control: fetches for two different locales are two requests', async () => {
        fetches.mockResolvedValue(ok as never);
        const tr = make();
        await Promise.all([tr.change('es-es'), tr.change('fr-fr')]);
        expect(fetches).toHaveBeenCalledTimes(2);
    });
});

describe('CACHE-2: the window follows the registration clock on the read side', () => {
    it('3s after the first failure, then 6s, then 12s', async () => {
        const tr = make();
        await tr.change('es-es');
        expect(fetches).toHaveBeenCalledTimes(1);

        for (const windowMs of [3_000, 6_000, 12_000]) {
            const before = fetches.mock.calls.length;
            vi.advanceTimersByTime(windowMs - 1);
            await tr.change('es-es');
            expect(fetches.mock.calls.length, `still inside the ${windowMs}ms window`).toBe(before);
            vi.advanceTimersByTime(1);
            await tr.change('es-es');
            expect(fetches.mock.calls.length, `just past the ${windowMs}ms window`).toBe(before + 1);
        }
        expect(fetches).toHaveBeenCalledTimes(4);
    });

    it('never longer than 5 minutes, however many failures in a row', async () => {
        const tr = make();
        for (let i = 0; i < 12; i++) {
            await tr.change('es-es');
            vi.advanceTimersByTime(300_000);
        }
        expect(fetches).toHaveBeenCalledTimes(12);
    });

    it('the first success clears it, so the next failure waits 3s again', async () => {
        const tr = make();
        for (let i = 0; i < 4; i++) {
            await tr.change('es-es');
            vi.advanceTimersByTime(60_000);
        }
        fetches.mockResolvedValueOnce(ok as never);
        await tr.change('es-es');
        expect(catalogUnavailable.get(), 'the success published a catalog').toBe(false);

        // Past the 60s a loaded catalog counts as fresh, so the next lookup fetches again.
        vi.advanceTimersByTime(61_000);
        fetches.mockResolvedValue(failed as never);
        await tr.change('es-es');
        const before = fetches.mock.calls.length;
        vi.advanceTimersByTime(3_000);
        await tr.change('es-es');
        expect(fetches.mock.calls.length, 'the window is 3s again, not the 48s five failures would give').toBe(before + 1);
    });

    it('inside the window, t() still never throws and nothing is queued', async () => {
        const tr = make();
        await tr.change('es-es');
        await tr.change('es-es');
        const t = tr.tSignal.get() as unknown as (p: string, c: string) => string;
        expect(() => t('Brand new', 'UI')).not.toThrow();
        expect((tr as unknown as { missingTokens: unknown[] }).missingTokens).toEqual([]);
    });

    it('an explicit refresh is a deliberate request, not a lookup, and goes out inside the window', async () => {
        const tr = make();
        await tr.change('es-es');
        await tr.change('es-es', true);
        expect(fetches).toHaveBeenCalledTimes(2);
    });
});
