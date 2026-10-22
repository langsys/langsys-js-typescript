import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContentBlock } from '../src/content-block.js';
import { HINT_MAX_DELAY_MS } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope } from '../src/request-scope.js';
import { setRequestScopeStorage } from '../src/scope-context.js';
import { autoDiscovery, discoveryBaseLocaleOnly, writeEnabled } from '../src/stores.js';
import seeds from './contract-seeds/contract-hint-lane.js';
import type { World } from './contract-seeds/worlds.js';
import { anyBlock, startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session as startSession, setHref, sleep, t, until } from './helpers/sdk-session.js';

/**
 * The report (hint) lane, graded against the API on an SDK test clone (spec CONF-2).
 *
 * The API declines a hint from a caller that can write, or from a key not permitted to
 * report. That makes "the SDK did not send" and "the SDK sent and was declined" identical in
 * what it stores. A "must not report" case is therefore built on CAPABILITY DRIFT where the API
 * can be made to accept: the SDK learns it must not report, then moves to an address the key's
 * allow-list does not hold, where the API WOULD store the hint. A correct SDK still sends nothing
 * and no hint is stored; an SDK that sends has its hint stored. Each such case has a control
 * showing the API stores that very hint when a session is permitted to send it. No route grants
 * a key the permission to report, so HINT-9's "not permitted" is observed where the client would
 * send, at `fetch`, beside its permitted cell on the clone. Each case takes a world of its own
 * from tests/contract-seeds/contract-hint-lane.ts.
 *
 * Reports wait 5 to 30 seconds of jitter. Timers are faked with auto-advance, so real network
 * I/O proceeds while a test jumps the jitter.
 */

let fx: ContractFixture;
const PAGE = 'https://site.local/page';

let w: World;

/** A fresh world for the case, named to the forwarder from the world's own address. */
async function take(name: Parameters<typeof seeds.take>[0]): Promise<World> {
    w = seeds.take(name);
    await fx.use(w);
    return w;
}

const session = (key: string) => startSession(fx.baseUrl, w.key(key), { project: w.project() });
const hints = async () => (await fx.hints(w)).map((h) => h.url);
const catalog = () => fx.held(w.key('k-public'), w.project(), 'es-es');
const blocks = async () => Object.keys((await catalog()).blocks.UI ?? {});
const blocksAnywhere = async () => anyBlock(await catalog());

/** The hint requests the SDK sends from here on, counted at the transport seam. */
function hintRequests(): () => string[] {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/discovery/hint')) sent.push(String(init?.body ?? ''));
        return real(input as string, init);
    });
    return () => sent;
}

/** The registration requests the SDK sends from here on, counted at the transport seam. */
function registrationRequests(): () => string[] {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/translatable-items') && init?.method === 'POST') sent.push(String(init.body ?? ''));
        return real(input as string, init);
    });
    return () => sent;
}

/** Record misses on the current page and run out the jitter, so the report goes out now. */
async function missAndRunOutJitter(...phrases: string[]): Promise<void> {
    for (const p of phrases) t(p);
    await vi.advanceTimersByTimeAsync(HINT_MAX_DELAY_MS + 1_000);
}
/** The clone's answer to a report, and its storing it, measured well inside this. */
const ROUND_TRIP_MS = 600;
/** A report sent once the jitter ran out has been stored by now. */
const settle = () => sleep(ROUND_TRIP_MS);

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    installBrowser(PAGE);
    for (const m of ['log', 'info', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    await take('base');
});
afterEach(() => {
    resetSdk();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('HINT-9: report only when the server permits it', () => {
    it('permitted: a read-only session reports the page, and the API stores it', async () => {
        await session('k-public');
        expect(autoDiscovery.get()).toBe(true);
        await missAndRunOutJitter('New on this page');
        await until(async () => (await hints()).includes(PAGE));
    });

    // The API declines this key's hint whether or not it is sent, so the absence is read at `fetch`:
    // a key of the same type, read-only from the same address, whose only difference is the permission.
    it('not permitted: the session sends no hint at all', async () => {
        const sent = hintRequests();
        await session('k-private');
        expect(autoDiscovery.get(), 'the SDK learned it may not report').toBe(false);
        await missAndRunOutJitter('New on this page');
        await settle();
        expect(sent()).toEqual([]);
    });
});

describe('GATE-6: a write-enabled session never reports', () => {
    it('a writer sends no hint, even once the server would accept one from it', async () => {
        await session('k-writer');
        expect(writeEnabled.get(), 'the SDK learned it may write').toBe(true);
        // To an address the key's allow-list does not hold, where the API stores its hints.
        await fx.update(w, { caller: w.moved });
        await missAndRunOutJitter('New on this page');
        await settle();
        expect(await hints()).toEqual([]);
    });

    it('control: in that same server state, a session that learns it is read-only does report', async () => {
        await fx.update(w, { caller: w.moved });
        await session('k-writer');
        expect(writeEnabled.get()).toBe(false);
        await missAndRunOutJitter('New on this page');
        await until(async () => (await hints()).includes(PAGE));
    });
});

describe('GATE-7: an unknown block feeds exactly one lane, in both directions', () => {
    const block = { custom_id: 'b-gate7', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };

    it('read-only: the page is reported (and the block is not registered)', async () => {
        await session('k-public');
        // The API refuses this session's write itself, so the registration's absence is the skip
        // and no request at the transport seam.
        const sent = registrationRequests();
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: false, skipped: true, reason: 'not-write-enabled' });
        await vi.advanceTimersByTimeAsync(HINT_MAX_DELAY_MS + 1_000);
        await until(async () => (await hints()).includes(PAGE));
        expect(sent()).toEqual([]);
        expect(await blocksAnywhere()).not.toContain('b-gate7');
    });

    it('write-enabled: the block is registered (and, per GATE-6, the page is not reported)', async () => {
        await session('k-writer');
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: true });
        expect(await blocks()).toContain('b-gate7');
    });
});

describe('HINT-7: the report lane carries no reliability machinery', () => {
    it('a rate-limit response ends reporting for the session, even after the server would take reports again', async () => {
        // The clone takes five hints a minute from one address: pages a to e.
        const accepted = ['a', 'b', 'c', 'd', 'e'].map((page) => `https://site.local/${page}`);
        await session('k-public');
        for (const page of accepted) {
            setHref(page);
            await missAndRunOutJitter(`Phrase on ${page}`);
            await until(async () => (await hints()).includes(page));
        }

        setHref('https://site.local/f');
        await missAndRunOutJitter('Page F phrase');
        await settle(); // F is answered 429, which ends reporting for this session

        await fx.advanceClock(61); // the server's per-minute window has reset
        setHref('https://site.local/g');
        await missAndRunOutJitter('Page G phrase');
        await settle();
        expect(await hints()).toEqual(accepted);
    });

    it('a failed report is never retried, however long the session runs', async () => {
        await fx.update(w, { faults: [{ method: 'POST', path: '/discovery/hint', times: 1, status: 500 }] });
        await session('k-public');
        await missAndRunOutJitter('New on this page');
        await settle();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await settle();
        expect(await hints()).toEqual([]);
    });
});

describe('GATE-9: the base-locale gate covers the report lane too', () => {
    it('on: a read-only session in a non-base locale reports nothing, although the server would store it', async () => {
        await take('gated');
        await session('k-public');
        expect(discoveryBaseLocaleOnly.get()).toBe(true);
        await missAndRunOutJitter('New on this page');
        await settle();
        expect(await hints()).toEqual([]);
    });

    it('control: off, the same session reports the page', async () => {
        await session('k-public');
        await missAndRunOutJitter('New on this page');
        await until(async () => (await hints()).includes(PAGE));
    });
});

describe('HINT-13: a route change re-enters the SDK, so a persistent layout is reported for the new page', () => {
    // A persistent layout: bound to `t`, it re-renders whenever `tSignal` publishes, and never
    // because the route changed. That is the shape bindings measured as never reporting page B.
    function mountPersistentLayout(): () => void {
        return LangsysApp.Translations.tSignal.subscribe((tFn) => {
            (tFn as unknown as (p: string, c: string) => string)('Layout phrase', 'UI');
        });
    }

    it('after notifyNavigation, the miss in the layout is stored for page B', async () => {
        await session('k-public');
        setHref('https://site.local/a');
        const unsubscribe = mountPersistentLayout();
        await missAndRunOutJitter();
        await until(async () => (await hints()).includes('https://site.local/a'));

        setHref('https://site.local/b');
        LangsysApp.notifyNavigation();
        await missAndRunOutJitter();
        await until(async () => (await hints()).includes('https://site.local/b'));
        unsubscribe();
    });

    it('without the call, the same layout records nothing for page B, although the API would store it', async () => {
        await session('k-public');
        setHref('https://site.local/a');
        const unsubscribe = mountPersistentLayout();
        await missAndRunOutJitter();
        await until(async () => (await hints()).includes('https://site.local/a'));

        setHref('https://site.local/b');
        await missAndRunOutJitter();
        await settle();
        expect(await hints()).toEqual(['https://site.local/a']);
        unsubscribe();
    });
});

describe('WIRE-2: an empty 204 is a success', () => {
    it('the hint route answers 204 with no body; the SDK treats it as sent and logs no failure', async () => {
        // Both channels: a body the client fails to parse is logged as an error, not a warning.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await session('k-public');
        await missAndRunOutJitter('New on this page');
        await until(async () => (await hints()).includes(PAGE));
        await settle();
        const text = (x: unknown) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
        const failures = [...warn.mock.calls, ...error.mock.calls]
            .map((c) => c.map(text).join(' '))
            .filter((s) => /hint failed|failed to query|API Error|Unexpected end of JSON/i.test(s))
            // The locale display data the SDK requests at start-up is not what this case grades.
            .filter((s) => !s.includes('/locales/'));
        expect(failures).toEqual([]);
    });
});

describe('SRV-2: a page’s report goes out under the page’s key', () => {
    it('a miss recorded inside a request scope with a key of its own reports under the page’s key', async () => {
        // Real timers: a timer the page sets inside a scope's async context runs in that context.
        vi.useRealTimers();
        await take('two projects');
        await session('k-public');
        vi.spyOn(Math, 'random').mockReturnValue(0);
        setRequestScopeStorage(new AsyncLocalStorage());
        try {
            const scope = await createRequestScope({ locale: 'en', credentials: { projectid: w.project('other'), key: w.key('k-other') } });
            scope.run(() => LangsysApp.Translations.recordPageMiss('', 'Recorded inside a scope'));
            await until(async () => (await fx.hints(w)).length > 0, 12_000);
        } finally {
            setRequestScopeStorage(null);
        }
        expect(await fx.hints(w)).toEqual([{ project_id: w.project(), url: PAGE }]);
    }, 20_000);
});
