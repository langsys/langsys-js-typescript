import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isContentBlockKnown, registerContentBlock } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { batchLimit, catalogUnavailable, currentlyLoadedLocale, discoveryBaseLocaleOnly, writeEnabled } from '../src/stores.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session as startSession, sleep, t, until } from './helpers/sdk-session.js';

/**
 * The write lane, graded against the contract double (spec CONF-2, tier `contract`).
 *
 * The SDK runs its real path — `LangsysApp.init`, the real HTTP client, real `fetch` — against
 * the double, and every assertion reads what the double ACCEPTED, never what the SDK sent.
 * An absence ("nothing was registered") is only evidence alongside a control that shows the
 * same wait would have observed a registration, so each such case carries one.
 */

let fx: ContractFixture;
const SETTLE_MS = 1200; // past the 400ms flush debounce, short of the 3s backoff

const SEED = {
    projects: [
        {
            id: 'p1',
            base_locale: 'en',
            target_locales: ['es-es'],
            website_url: 'https://site.local',
            phrases: [{ category: 'UI', phrase: 'Known', translations: { 'es-es': 'Conocido' } }],
        },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-read', project: 'p1', type: 'read' },
        { key: 'k-ipw', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1'] },
    ],
};
const withConfig = (config: Record<string, unknown>) => ({ ...SEED, config });
const withAllowlist = (list: string[]) => ({
    ...SEED,
    keys: SEED.keys.map((k) => (k.key === 'k-ipw' ? { ...k, ip_allowlist: list } : k)),
});

const registered = async () => (await fx.state()).projects.p1.phrases.map((p) => p.phrase);

const session = (key: string, opts: { awaitCatalog?: boolean; locale?: string } = {}) => startSession(fx.baseUrl, key, opts);

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    installBrowser();
    for (const m of ['log', 'info', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    await fx.seed(SEED);
});
afterEach(() => {
    resetSdk();
    vi.restoreAllMocks();
});

describe('GATE-1: the decision is the server-computed write_enabled, never the key type', () => {
    // The double refuses a write from a session that may not write, so "did not register"
    // is only evidence when the double WOULD have accepted the write. Hence the drift: the
    // session learns it is read-only, then the server's allow-list admits it. A client that
    // decided by key type would now send and be stored; a conforming one sends nothing.
    it('an ip_write session judged read-only does not register, even once the server would accept it', async () => {
        await fx.seed(withAllowlist(['10.1.1.1']));
        await session('k-ipw');
        expect(writeEnabled.get(), 'the server computed read-only').toBe(false);
        await fx.seed(withAllowlist(['127.0.0.1']));
        t('Not while read-only');
        await sleep(SETTLE_MS);
        expect(await registered()).not.toContain('Not while read-only');
    });

    it('control: the same ip_write key, allow-listed, registers', async () => {
        await session('k-ipw');
        expect(writeEnabled.get()).toBe(true);
        t('From here');
        await until(async () => (await registered()).includes('From here'));
    });
});

describe('GATE-2: a phrase seen before the decision is available is sent once it resolves', () => {
    it('a miss recorded before authorization is held, then registered', async () => {
        resetSdk();
        const init = LangsysApp.init({ projectid: 'p1', key: 'k-write', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        t('Seen before the decision');
        expect(writeEnabled.get(), 'the decision is not known yet').toBeUndefined();
        await init;
        await until(async () => (await registered()).includes('Seen before the decision'));
    });
});

describe('GATE-5 and REG-8: acceptance, not the attempt, is what counts as seen', () => {
    it('a send the server refuses stays queued, backs off, and lands on a later attempt', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        await session('k-write');
        t('Refused once');
        await sleep(SETTLE_MS);
        expect(await registered(), 'the first attempt was refused').not.toContain('Refused once');
        await until(async () => (await registered()).includes('Refused once'), 10_000);
    }, 15_000);
});

describe('REG-9: batches follow the limit the server advertises', () => {
    it('seven misses against a limit of three all land, where one unchunked batch would be refused', async () => {
        await fx.seed(withConfig({ batch_limit: 3 }));
        await session('k-write');
        const phrases = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];
        for (const p of phrases) t(p);
        await until(async () => {
            const all = await registered();
            return phrases.every((p) => all.includes(p));
        });
        expect(batchLimit.get(), 'the advertised limit was adopted').toBe(3);
    });
});

describe('GATE-8: a missing write_enabled is a version signal', () => {
    it('against a legacy server a write key registers and a read key does not', async () => {
        await fx.seed(withConfig({ legacy_omit_capability: true }));
        await session('k-read');
        t('Legacy read');
        await sleep(SETTLE_MS);
        await session('k-write');
        t('Legacy write');
        await until(async () => (await registered()).includes('Legacy write'));
        expect(await registered()).not.toContain('Legacy read');
    });
});

describe('REG-10: a failed registration is never reported as a success', () => {
    const block = { custom_id: 'b-reg10', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };
    const blockIds = async () => (await fx.state()).projects.p1.blocks.map((b) => b.custom_id);

    it('a refused block registration returns status false, does not throw, and leaves nothing', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        await session('k-write');
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: false });
        expect(await blockIds()).not.toContain('b-reg10');
    });

    it('control: the same registration succeeds and the block is held by the server', async () => {
        await session('k-write');
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: true });
        expect(await blockIds()).toContain('b-reg10');
    });
});

describe('WIRE-4: an unreachable catalog degrades, and registers nothing', () => {
    it('with the catalog fetch dropped, t() returns source text and no miss is registered', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', times: 1, drop: true }] });
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        expect(() => t('Known')).not.toThrow();
        expect(t('Known')).toBe('Known');
        t('During the outage');
        await sleep(SETTLE_MS);
        expect(await registered()).not.toContain('During the outage');
        expect(await registered(), 'control: the catalog phrase is still held server-side').toContain('Known');
    });
});

describe('GATE-9: the base-locale gate the handshake sends', () => {
    const gated = { ...SEED, projects: [{ ...SEED.projects[0], discovery_base_locale_only: true }] };

    it('on: a miss in a non-base locale is not registered, although the server would accept it', async () => {
        await fx.seed(gated);
        await session('k-write');
        expect(discoveryBaseLocaleOnly.get(), 'read from the handshake').toBe(true);
        t('Gated away');
        await sleep(SETTLE_MS);
        expect(await registered()).not.toContain('Gated away');
    });

    it('on: the same miss at the base locale registers', async () => {
        await fx.seed(gated);
        await session('k-write', { locale: 'en' });
        t('At the base locale');
        await until(async () => (await registered()).includes('At the base locale'));
    });

    // The authorize response carries the setting as well as the catalog envelope, and it is
    // the only source during the gap before the catalog lands. A miss in that gap must already
    // be gated; a client reading only the envelope would record it and register it later.
    it('on: a miss before the catalog arrives is already gated by the authorize response', async () => {
        await fx.seed({ ...gated, faults: [{ method: 'GET', path: '/translations', times: 1, delay_ms: 1500 }] });
        await session('k-write', { awaitCatalog: false });
        expect(discoveryBaseLocaleOnly.get(), 'known from authorize alone').toBe(true);
        t('Before the catalog');
        await until(() => currentlyLoadedLocale.get() === 'es-es');
        await sleep(SETTLE_MS);
        expect(await registered()).not.toContain('Before the catalog');
    });

    it('control: off, a miss before the catalog arrives is registered once it lands', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', times: 1, delay_ms: 1500 }] });
        await session('k-write', { awaitCatalog: false });
        t('Before the catalog');
        await until(async () => (await registered()).includes('Before the catalog'));
    });

    it('control: off, the same miss in the same locale registers', async () => {
        await session('k-write');
        expect(discoveryBaseLocaleOnly.get()).toBe(false);
        t('Not gated');
        await until(async () => (await registered()).includes('Not gated'));
    });
});

describe('GATE-9 on the content-block path', () => {
    it('on: a block in a non-base locale is not registered, although the server would accept it', async () => {
        await fx.seed({ ...SEED, projects: [{ ...SEED.projects[0], discovery_base_locale_only: true }] });
        await session('k-write');
        const block = { custom_id: 'b-gated', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['Gated A', 'Gated B'] };
        await registerContentBlock(block as never);
        await sleep(300);
        expect((await fx.state()).projects.p1.blocks.map((b) => b.custom_id)).not.toContain('b-gated');
    });

    it('control: off, the same block is registered', async () => {
        await session('k-write');
        const block = { custom_id: 'b-open', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['Open A', 'Open B'] };
        await registerContentBlock(block as never);
        expect((await fx.state()).projects.p1.blocks.map((b) => b.custom_id)).toContain('b-open');
    });
});

describe('WIRE-3: an uncategorised block is read back under __uncategorized__', () => {
    it('a block registered with no category is known to the next session, so it is not registered again', async () => {
        await session('k-write');
        const block = { custom_id: 'b-uncat', category: '', content: '<p>Alpha</p><p>Beta</p>', label: 'x', tokens: ['Alpha', 'Beta'] };
        await expect(registerContentBlock(block as never)).resolves.toMatchObject({ status: true });
        await session('k-write');
        expect(isContentBlockKnown('', 'b-uncat')).toBe(true);
    });
});

describe('CACHE-2: a failed catalog fetch is remembered for a bounded window', () => {
    // One failure, with a catalog behind it: after the fault the double answers normally. What
    // the test reads is the page — a refetch inside the window would change what `t()` renders.
    const oneFailure = { ...SEED, faults: [{ method: 'GET', path: '/translations', times: 1, status: 500 }] };

    it('inside the window a lookup renders source text, although the server would now answer', async () => {
        await fx.seed(oneFailure);
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        await LangsysApp.Translations.change('es-es');
        await sleep(300);
        expect(t('Known')).toBe('Known');
    });

    it('after the window the next lookup fetches again, and the translation renders', async () => {
        await fx.seed(oneFailure);
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        await sleep(3200);
        await LangsysApp.Translations.change('es-es');
        await until(() => t('Known') === 'Conocido');
    }, 15_000);
});

describe('OBS-1: an unusable capability is surfaced once', () => {
    const notices = (warn: ReturnType<typeof vi.spyOn>) =>
        warn.mock.calls.map((c) => c.map(String).join(' ')).filter((s) => s.includes('this session cannot write'));

    it('an ip_write key the double refuses warns once however many misses follow', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await fx.seed(withAllowlist(['10.1.1.1']));
        await session('k-ipw');
        for (const p of ['m1', 'm2', 'm3']) t(p);
        await sleep(SETTLE_MS);
        expect(notices(warn)).toHaveLength(1);
    });

    // Run after the ip_write case on purpose. `init()` hands the Translations instance its new
    // config only after authorization has been applied, so on a re-init the notice used to read
    // the PREVIOUS key's type and warn about an ip_write key during a read-key session.
    it('control: a read key, which is behaving correctly, is not warned about, even after a refused ip_write session', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await session('k-read');
        t('m4');
        await sleep(SETTLE_MS);
        expect(notices(warn)).toHaveLength(0);
    });
});
