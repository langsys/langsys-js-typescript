import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';
import { sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * The registration write lane. Every case here is a regression that shipped or
 * nearly shipped, and each failed silently — no error, no throw, nothing in the
 * catalog. They lived in a session scratchpad until now.
 */

interface Call {
    at: number;
    phrases: string[];
    keepalive: boolean;
}

let calls: Call[] = [];
let t0 = 0;
const listeners: Record<string, Array<() => void>> = {};

function installBrowserShim(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    const addEventListener = (evt: string, h: () => void) => void ((listeners[evt] ??= []).push(h));
    g.window = { addEventListener, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener, visibilityState: 'visible' };
    g.sessionStorage = { getItem: () => null, setItem: () => {} };
}

function removeBrowserShim(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
}

function fire(evt: string): void {
    (listeners[evt] ?? []).forEach((h) => h());
}

/**
 * Instances installed by `setup()` keep a 3s backstop interval running, and
 * nothing disposes them — so without this an earlier test's instance fires mid
 * way through a later one and writes into the shared call log. That cross-test
 * bleed is exactly what made an earlier version of this harness report a
 * failure that wasn't there.
 */
const live: Translations[] = [];

function newTranslations(ssrTokenStrategy?: 'client' | 'server' | 'auto') {
    const t = new Translations({
        projectid: 'p',
        key: 'k',
        sUserLocale: createSignal('en-US'),
        baseLocale: 'en',
        ssrTokenStrategy,
    });
    live.push(t);
    return t;
}

function stopAll(): void {
    for (const t of live) {
        const timer = (t as unknown as { timer: ReturnType<typeof setInterval> | null }).timer;
        if (timer) clearInterval(timer);
        (t as unknown as { timer: null }).timer = null;
        (t as unknown as { missingTokens: unknown[] }).missingTokens = [];
    }
    live.length = 0;
}

/** Reach the private backstop handle — the point of these tests is whether it is running. */
const timerOf = (t: Translations) => (t as unknown as { timer: ReturnType<typeof setInterval> | null }).timer;

/** Reach the private queue — these tests are about bookkeeping, not the public API. */
const queueOf = (t: Translations) => (t as unknown as { missingTokens: Array<{ token: string }> }).missingTokens;

beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    calls = [];
    t0 = Date.now();
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
    });
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(
        async (items: Array<Record<string, unknown>>, opts?: { keepalive?: boolean }) => {
            calls.push({
                at: Date.now() - t0,
                phrases: items.map((i) => String(i.phrase)),
                keepalive: !!opts?.keepalive,
            });
            return { status: true };
        },
    );
});

afterEach(() => {
    stopAll();
    vi.restoreAllMocks();
    removeBrowserShim();
});

describe('the backstop interval is demand-driven', () => {
    // It used to start in `setup()` and run for the life of the page whether
    // or not anything was ever queued. On a phone that is a wakeup every three
    // seconds forever, for a queue that is almost always empty — and React
    // Native takes this same client path, since it defines `window`.
    beforeEach(() => {
        installBrowserShim();
        writeEnabled.set(true);
    });

    it('does not start on setup with nothing queued', () => {
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        expect(timerOf(tr)).toBeNull();
    });

    it('arms on the first miss and disarms once the queue drains', async () => {
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });

        tr.t('Backstop phrase', 'UI');
        expect(timerOf(tr)).not.toBeNull();

        await new Promise((r) => setTimeout(r, 800));

        expect(queueOf(tr)).toHaveLength(0);
        expect(timerOf(tr)).toBeNull();
    });

    it('keeps running while a send keeps failing, which is what a backstop is for', async () => {
        vi.mocked(LangsysAppAPI.createTranslatableItems).mockImplementation(async () => ({
            status: false,
            errors: ['nope'],
        }));

        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });

        tr.t('Undeliverable phrase', 'UI');
        await new Promise((r) => setTimeout(r, 800));

        expect(queueOf(tr).length).toBeGreaterThan(0);
        expect(timerOf(tr)).not.toBeNull();
    });

    it('stops when a read-only session releases the queue', async () => {
        // The cell none of the other three cover. A miss recorded before
        // authorization resolves is HELD (capability unknown), which arms the
        // backstop; authorization then comes back read-only with no grant, and
        // the release path empties the queue directly. `updateTokens` returns
        // early on an empty queue — before the disarm — so the interval ticked
        // every 3s doing nothing for the life of the page. That is precisely
        // the cost this item claims to remove.
        writeEnabled.set(undefined);
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });

        tr.t('Held before auth', 'UI');
        expect(queueOf(tr).length).toBeGreaterThan(0);
        expect(timerOf(tr)).not.toBeNull();

        writeEnabled.set(false);

        expect(queueOf(tr)).toHaveLength(0);
        expect(timerOf(tr)).toBeNull();
    });

    it('destroy() stops it', async () => {
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        tr.t('Another phrase', 'UI');
        expect(timerOf(tr)).not.toBeNull();

        tr.destroy();
        expect(timerOf(tr)).toBeNull();
    });
});

describe('flush timing', () => {
    beforeEach(() => {
        installBrowserShim();
        writeEnabled.set(true);
    });

    it('sends late-rendering content sub-second rather than on the 3s poll tick', async () => {
        // The discovery renderer allows ~4s after its scroll phase. Waiting for
        // a 3s interval left ~1s of real budget, so lazy-loaded and streamed
        // content — exactly what discovery targets — was recorded and then
        // destroyed with the page.
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        await new Promise((r) => setTimeout(r, 20));
        calls = [];
        t0 = Date.now();

        tr.t('Late rendered phrase', 'UI');
        await new Promise((r) => setTimeout(r, 800));

        expect(calls).toHaveLength(1);
        expect(calls[0].at).toBeLessThan(1000);
        expect(calls[0].phrases).toEqual(['Late rendered phrase']);
    });

    it('still coalesces a burst into a single request', async () => {
        const tr = newTranslations();
        for (let i = 0; i < 8; i++) tr.t(`Burst ${i}`, 'UI');
        await new Promise((r) => setTimeout(r, 800));

        expect(calls).toHaveLength(1);
        expect(calls[0].phrases).toHaveLength(8);
    });
});

describe('teardown flush', () => {
    beforeEach(() => {
        installBrowserShim();
        writeEnabled.set(true);
    });

    it('sends what is still queued when the page goes away, with keepalive', () => {
        // Not sendBeacon: it cannot set custom headers, and authorization is a
        // header — so every beacon would be rejected silently.
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        tr.t('Phrase caught by teardown', 'UI');

        (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
        fire('visibilitychange');

        expect(calls).toHaveLength(1);
        expect(calls[0].keepalive).toBe(true);
        expect(calls[0].phrases).toEqual(['Phrase caught by teardown']);
    });

    it('does not re-send what the debounce already sent — visibilitychange also fires on a tab switch', async () => {
        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        tr.t('Already sent', 'UI');
        await new Promise((r) => setTimeout(r, 800));
        const afterNormalFlush = calls.length;

        (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
        fire('visibilitychange');
        fire('pagehide');
        await new Promise((r) => setTimeout(r, 50));

        expect(calls).toHaveLength(afterNormalFlush);
    });
});

describe('in-flight safety', () => {
    beforeEach(() => {
        installBrowserShim();
        writeEnabled.set(true);
    });

    it('does not drop a miss recorded while a send is in flight', async () => {
        // This was silent, permanent loss: the mid-flight phrase was marked
        // present in the catalog and cleared from the queue without ever being
        // in a payload, and then read as already-known so was never retried.
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let held = true;

        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(
            async (items: Array<Record<string, unknown>>) => {
                calls.push({ at: 0, phrases: items.map((i) => String(i.phrase)), keepalive: false });
                if (held) await gate;
                return { status: true };
            },
        );

        const tr = newTranslations('server');
        tr.applyWriteEnabled(true);
        tr.t('First', 'UI');
        await new Promise((r) => setTimeout(r, 600)); // past the 400ms debounce
        expect(calls).toHaveLength(1); // in flight, held

        tr.t('Second', 'UI'); // recorded DURING the request
        held = false;
        release();
        // The follow-up flush is re-scheduled through the same 400ms debounce.
        await new Promise((r) => setTimeout(r, 700));

        const allSent = calls.flatMap((c) => c.phrases);
        expect(allSent).toContain('Second');
        expect(allSent.filter((p) => p === 'First')).toHaveLength(1); // no duplicate re-send
        expect(queueOf(tr)).toHaveLength(0);
    });
});

describe('retry backoff', () => {
    beforeEach(() => {
        installBrowserShim();
        writeEnabled.set(true);
    });

    it('backs off instead of hammering a failing server, and keeps the batch', async () => {
        // Without backoff a failing endpoint got a request every 3s for the
        // life of the page — with a payload that GREW as new misses joined a
        // queue that never drained.
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async () => {
            calls.push({ at: 0, phrases: [], keepalive: false });
            return { status: false, errors: ['HTTP 500'] };
        });

        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        tr.t('Doomed', 'UI');
        await new Promise((r) => setTimeout(r, 800));
        expect(calls).toHaveLength(1);

        for (let i = 0; i < 6; i++) {
            await (tr as unknown as { updateTokens: () => Promise<boolean> }).updateTokens();
        }
        expect(calls).toHaveLength(1); // suppressed
        expect(queueOf(tr)).toHaveLength(1); // and not lost

        (tr as unknown as { retryNotBefore: number }).retryNotBefore = Date.now() - 1;
        await (tr as unknown as { updateTokens: () => Promise<boolean> }).updateTokens();
        expect(calls).toHaveLength(2); // retries once the window elapses
    });
});

describe('SSR collects only what it can actually send', () => {
    // No browser shim here — this is the real server path.
    it("'client' does not collect: the post-hydration flush reads a different process", () => {
        const tr = newTranslations('client');
        tr.applyWriteEnabled(true);
        tr.t('SSR client phrase', 'UI');
        expect(queueOf(tr)).toHaveLength(0);
    });

    it("'server' does collect, because it flushes in-process", () => {
        const tr = newTranslations('server');
        tr.applyWriteEnabled(true);
        tr.t('SSR server phrase', 'UI');
        expect(queueOf(tr).map((t) => t.token)).toEqual(['SSR server phrase']);
    });

    it("'auto' collects only up to its flush threshold", () => {
        const tr = newTranslations('auto');
        tr.applyWriteEnabled(true);
        for (let i = 0; i < 12; i++) tr.t(`Auto ${i}`, 'UI');
        expect(queueOf(tr)).toHaveLength(5);
    });
});

describe('review regressions', () => {
    it('TS-1: does not collect under SSR when a grant makes the server lane unusable', () => {
        // canWrite() refuses the SSR lane whenever a grant is configured, so
        // collecting anyway rebuilds the undrainable plateau: nothing can send
        // it, and the writeEnabled release path never fires server-side.
        LangsysAppAPI.setup({
            projectid: 'p',
            key: 'k',
            sUserLocale: createSignal('en-US'),
            baseLocale: 'en',
            writeGrant: () => 'jwt',
        });
        const tr = newTranslations('server');
        tr.applyWriteEnabled(true);
        tr.t('SSR phrase with a grant configured', 'UI');

        expect(queueOf(tr)).toHaveLength(0);
        LangsysAppAPI.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
    });

    it('TS-3: a prototype-named phrase is actually sent, not filtered out of every batch', async () => {
        installBrowserShim();
        writeEnabled.set(true);
        sTranslations.set({
            UI: { __category__: 'UI', __symbol__: 'UI' },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });

        const tr = newTranslations();
        tr.t('constructor', 'UI');
        await new Promise((r) => setTimeout(r, 800));

        expect(calls.flatMap((c) => c.phrases)).toContain('constructor');
    });

    it('TS-2/TS-4: teardown sends despite an in-flight lock, and chunks smaller', async () => {
        installBrowserShim();
        writeEnabled.set(true);

        const tr = newTranslations();
        tr.setup({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-US'), baseLocale: 'en' });
        for (let i = 0; i < 60; i++) tr.t(`Phrase ${i}`, 'UI');

        // Simulate a normal send being in flight when the page dies.
        (tr as unknown as { updateInFlight: boolean }).updateInFlight = true;

        (globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState = 'hidden';
        fire('visibilitychange');
        await new Promise((r) => setTimeout(r, 50));

        expect(calls.length).toBeGreaterThan(0); // not blocked by the lock
        expect(calls.every((c) => c.keepalive)).toBe(true);
        // 60 phrases must not go as one oversized keepalive body.
        expect(calls.every((c) => c.phrases.length <= 50)).toBe(true);
    });
});
