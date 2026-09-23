import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContentBlock } from '../src/content-block.js';
import { autoDiscovery, discoveryBaseLocaleOnly, writeEnabled } from '../src/stores.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session as startSession, setHref, sleep, t, until } from './helpers/sdk-session.js';

/**
 * The report (hint) lane, graded against the contract double (spec CONF-2, tier `contract`).
 *
 * The double applies the backend's own acceptance rules, so it declines a hint from a caller
 * that can write, or from a key not permitted to report — exactly as the real server does.
 * That makes "the SDK did not send" and "the SDK sent and was declined" identical in the
 * double's state. Every "must not report" case is therefore built on CAPABILITY DRIFT: the
 * SDK learns it must not report, then the double's world changes so it WOULD store the hint.
 * A correct SDK still sends nothing and the state stays empty; an SDK that sends has its
 * hint stored. Each such case has a control showing the double stores that very hint when a
 * session is permitted to send it.
 *
 * Reports wait 5 to 30 seconds of jitter. Timers are faked with auto-advance, so real network
 * I/O proceeds while a test jumps the jitter.
 */

let fx: ContractFixture;
const PAGE = 'https://site.local/page';

const SEED = {
    config: { renderer_egress_ips: ['10.9.9.9'] },
    projects: [{ id: 'p1', base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local' }],
    keys: [
        // Read-only from here, and permitted to report: the canonical public site.
        { key: 'k-public', project: 'p1', type: 'ip_write', report_discovered_content: true },
        // Read-only from here, and NOT permitted to report.
        { key: 'k-private', project: 'p1', type: 'ip_write', report_discovered_content: false },
        // May write from here (allow-listed), and permitted to report.
        { key: 'k-writer', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1'], report_discovered_content: true },
    ],
};
/** The same project, with one key's server-side policy changed. */
function drift(key: string, change: Record<string, unknown>) {
    return { ...SEED, keys: SEED.keys.map((k) => (k.key === key ? { ...k, ...change } : k)) };
}

const session = (key: string) => startSession(fx.baseUrl, key);
const gated = () => ({ ...SEED, projects: [{ ...SEED.projects[0], discovery_base_locale_only: true }] });
const hints = async () => (await fx.state()).hints.map((h) => h.url);
const blocks = async () => (await fx.state()).projects.p1.blocks.map((b) => b.custom_id);

/** Record misses on the current page and run out the jitter, so the report goes out now. */
async function missAndRunOutJitter(...phrases: string[]): Promise<void> {
    for (const p of phrases) t(p);
    await vi.advanceTimersByTimeAsync(31_000);
}
/** Long enough for a sent report to have been stored. */
const settle = () => sleep(600);

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
    await fx.seed(SEED);
});
afterEach(() => {
    resetSdk();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('HINT-9: report only when the server permits it', () => {
    it('permitted: a read-only session reports the page, and the double stores it', async () => {
        await session('k-public');
        expect(autoDiscovery.get()).toBe(true);
        await missAndRunOutJitter('New on this page');
        await until(async () => (await hints()).includes(PAGE));
    });

    it('not permitted: the session reports nothing, even once the server would accept its hint', async () => {
        await session('k-private');
        expect(autoDiscovery.get(), 'the SDK learned it may not report').toBe(false);
        await fx.seed(drift('k-private', { report_discovered_content: true }));
        await missAndRunOutJitter('New on this page');
        await settle();
        expect(await hints()).toEqual([]);
    });
});

describe('GATE-6: a write-enabled session never reports', () => {
    it('a writer sends no hint, even once the server would accept one from it', async () => {
        await session('k-writer');
        expect(writeEnabled.get(), 'the SDK learned it may write').toBe(true);
        await fx.seed(drift('k-writer', { ip_allowlist: [] }));
        await missAndRunOutJitter('New on this page');
        await settle();
        expect(await hints()).toEqual([]);
    });

    it('control: in that same server state, a session that learns it is read-only does report', async () => {
        await fx.seed(drift('k-writer', { ip_allowlist: [] }));
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
        await registerContentBlock(block as never);
        await vi.advanceTimersByTimeAsync(31_000);
        await until(async () => (await hints()).includes(PAGE));
        expect(await blocks()).not.toContain('b-gate7');
    });

    it('write-enabled: the block is registered (and, per GATE-6, the page is not reported)', async () => {
        await session('k-writer');
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: true });
        expect(await blocks()).toContain('b-gate7');
    });
});

describe('HINT-7: the report lane carries no reliability machinery', () => {
    it('a rate-limit response ends reporting for the session, even after the server would take reports again', async () => {
        await fx.seed({ ...SEED, config: { ...SEED.config, hint_rate_per_minute: 1 } });
        await session('k-public');
        setHref('https://site.local/a');
        await missAndRunOutJitter('Page A phrase');
        await until(async () => (await hints()).includes('https://site.local/a'));

        setHref('https://site.local/b');
        await missAndRunOutJitter('Page B phrase');
        await settle(); // B is answered 429, which ends reporting for this session

        await fx.advanceClock(61); // the server's per-minute window has reset
        setHref('https://site.local/c');
        await missAndRunOutJitter('Page C phrase');
        await settle();
        expect(await hints()).toEqual(['https://site.local/a']);
    });

    it('a failed report is never retried, however long the session runs', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'POST', path: '/discovery/hint', times: 1, status: 500 }] });
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
        await fx.seed(gated());
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
            // The locale display data the SDK requests at start-up is outside the double's contract.
            .filter((s) => !s.includes('/locales/'));
        expect(failures).toEqual([]);
    });
});
