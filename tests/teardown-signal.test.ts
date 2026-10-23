import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';
import { catalogUnavailable, sTranslations, writeEnabled } from '../src/stores.js';
import { setTeardownSignal } from '../src/teardown.js';
import { Translations } from '../src/translations.js';

/**
 * REG-3 on a host with no `document` — React Native — through an injected teardown signal.
 *
 * A browser flushes on `visibilitychange → hidden` and `pagehide` (proven in `write-lane`).
 * React Native defines `window` but has no `document`, so without a signal from the host
 * anything still queued when the app leaves the foreground is lost. `setTeardownSignal` takes
 * that signal from the binding and runs the core's own teardown flush: the ordinary send, with
 * keepalive.
 */

const g = globalThis as unknown as Record<string, unknown>;
let register: ReturnType<typeof vi.spyOn>;
const live: Translations[] = [];
const config = { projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' };

/** A set-up session with one phrase queued and not yet sent. */
function sessionWithQueuedMiss(): Translations {
    const tr = new Translations(config);
    tr.setup(config);
    live.push(tr);
    (tr.tSignal.get() as unknown as (p: string, c: string) => string)('Queued when the app left', 'UI');
    return tr;
}
const drain = () => vi.advanceTimersByTimeAsync(0);
const sentWithKeepalive = () => register.mock.calls.filter((c) => (c[1] as { keepalive?: boolean } | undefined)?.keepalive === true);

beforeEach(() => {
    // React Native's shape: a `window`, and no `document`.
    g.window = { addEventListener: () => {}, location: { href: 'https://app.local/' } };
    delete g.document;
    writeEnabled.set(true);
    catalogUnavailable.set(false);
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    register = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true } as never);
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
});

afterEach(() => {
    setTeardownSignal(null);
    for (const tr of live) tr.destroy();
    live.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    delete g.window;
});

describe('REG-3 on a host with no document: the injected teardown signal', () => {
    it('flushes what is queued, with keepalive, for a session set up before the signal was injected', async () => {
        sessionWithQueuedMiss();
        let fire!: () => void;
        setTeardownSignal((f) => {
            fire = f;
            return () => {};
        });
        fire();
        await drain();
        expect(sentWithKeepalive()).toHaveLength(1);
        expect(JSON.stringify(sentWithKeepalive()[0]![0])).toContain('Queued when the app left');
    });

    it('and for a session set up after it', async () => {
        let fire!: () => void;
        setTeardownSignal((f) => {
            fire = f;
            return () => {};
        });
        sessionWithQueuedMiss();
        fire();
        await drain();
        expect(sentWithKeepalive()).toHaveLength(1);
    });

    it('control: with no signal injected, nothing is sent when the app leaves', async () => {
        sessionWithQueuedMiss();
        await drain();
        expect(register).not.toHaveBeenCalled();
    });

    it('firing with nothing queued sends nothing', async () => {
        const tr = new Translations(config);
        tr.setup(config);
        live.push(tr);
        let fire!: () => void;
        setTeardownSignal((f) => {
            fire = f;
            return () => {};
        });
        fire();
        await drain();
        expect(register).not.toHaveBeenCalled();
    });

    it('a destroyed session is not flushed', async () => {
        const tr = sessionWithQueuedMiss();
        let fire!: () => void;
        setTeardownSignal((f) => {
            fire = f;
            return () => {};
        });
        tr.destroy();
        fire();
        await drain();
        expect(register).not.toHaveBeenCalled();
    });
});

describe('setTeardownSignal releases what it replaces', () => {
    it('a new signal unsubscribes the previous one first, so one departure flushes once (Fast Refresh)', async () => {
        sessionWithQueuedMiss();
        const releaseFirst = vi.fn();
        setTeardownSignal(() => releaseFirst);
        let fire!: () => void;
        setTeardownSignal((f) => {
            fire = f;
            return () => {};
        });
        expect(releaseFirst).toHaveBeenCalledTimes(1);
        fire();
        await drain();
        expect(sentWithKeepalive()).toHaveLength(1);
    });

    it('null releases the current signal and injects none', () => {
        const release = vi.fn();
        setTeardownSignal(() => release);
        setTeardownSignal(null);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('a subscribe that returns nothing is accepted', () => {
        expect(() => setTeardownSignal(() => undefined)).not.toThrow();
    });
});
