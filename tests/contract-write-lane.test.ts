import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBlock, renderBlock, serializeTree } from '../src/block-tree.js';
import { generateCustomId, isContentBlockKnown, registerContentBlock } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { batchLimit, catalogUnavailable, currentlyLoadedLocale, discoveryBaseLocaleOnly, writeEnabled } from '../src/stores.js';
import { CLIENT_FLUSH_DEBOUNCE_MS, failureWindowMs, RETRY_BACKOFF_BASE_MS } from '../src/translations.js';
import seeds from './contract-seeds/contract-write-lane.js';
import type { World } from './contract-seeds/worlds.js';
import { anyBlock, anyPhrase, startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session as startSession, sleep, t, until } from './helpers/sdk-session.js';

/**
 * The write lane, graded against the API on an SDK test clone (spec CONF-2).
 *
 * The SDK runs its real path — `LangsysApp.init`, the real HTTP client, real `fetch` — against
 * the API, and every assertion reads what the API ACCEPTED, never what the SDK sent.
 * An absence ("nothing was registered") is only evidence alongside a control that shows the
 * same wait would have observed a registration, so each such case carries one. Each case takes a
 * world of its own from tests/contract-seeds/contract-write-lane.ts.
 */

let fx: ContractFixture;
// The clone's answer to a registration, and its catalog serving it, measured well inside this.
const ROUND_TRIP_MS = 800;
// An absence is read once the SDK's flush would have sent and the clone answered, short of the
// retry backoff a refused send waits out.
const SETTLE_MS = CLIENT_FLUSH_DEBOUNCE_MS + ROUND_TRIP_MS;
if (SETTLE_MS >= RETRY_BACKOFF_BASE_MS) throw new Error('the settle window reaches the retry backoff');
// How long the forwarder holds a request to keep it in flight, well past a re-init against the clone.
const IN_FLIGHT_MS = 8_000;

let w: World;

/** A fresh world for the case, named to the forwarder from the world's own address. */
async function take(name: Parameters<typeof seeds.take>[0]): Promise<World> {
    w = seeds.take(name);
    await fx.use(w);
    return w;
}

// What was registered, as the API's catalog serves it: a presence under the category it was
// registered with, an absence under any.
const catalog = () => fx.held(w.key('k-write'), w.project(), 'es-es');
const registered = async (category = 'UI') => (await catalog()).phrases[category] ?? [];
const heldBlocks = async (category = 'UI') => Object.keys((await catalog()).blocks[category] ?? {});
const registeredAnywhere = async () => anyPhrase(await catalog());
const heldAnywhere = async () => anyBlock(await catalog());

const session = (key: string, opts: { awaitCatalog?: boolean; locale?: string } = {}) => startSession(fx.baseUrl, w.key(key), { ...opts, project: w.project() });
const init = (locale: string) => LangsysApp.init({ projectid: w.project(), key: w.key('k-write'), UserLocaleStore: createSignal(locale), baseLocale: 'en', apiUrl: fx.baseUrl });

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
    await take('base');
});
afterEach(() => {
    resetSdk();
    vi.restoreAllMocks();
});

describe('GATE-1: the decision is the server-computed write_enabled, never the key type', () => {
    // The API refuses a write from a session that may not write, so "did not register"
    // is only evidence when the API WOULD have accepted the write. Hence the drift: the
    // session learns it is read-only, then moves to an address the key's allow-list holds. A
    // client that decided by key type would now send and be stored; a conforming one sends nothing.
    it('an ip_write session judged read-only does not register, even once the server would accept it', async () => {
        await take('ipw elsewhere');
        await session('k-ipw');
        expect(writeEnabled.get(), 'the server computed read-only').toBe(false);
        await fx.update(w, { caller: w.moved });
        t('Not while read-only');
        await sleep(SETTLE_MS);
        expect(await registeredAnywhere()).not.toContain('Not while read-only');
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
        const started = init('es-es');
        t('Seen before the decision');
        expect(writeEnabled.get(), 'the decision is not known yet').toBeUndefined();
        await started;
        await until(async () => (await registered()).includes('Seen before the decision'));
    });
});

describe('GATE-5 and REG-8: acceptance, not the attempt, is what counts as seen', () => {
    it('a send the server refuses stays queued, backs off, and lands on a later attempt', async () => {
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        await session('k-write');
        t('Refused once');
        await sleep(SETTLE_MS);
        expect(await registeredAnywhere(), 'the first attempt was refused').not.toContain('Refused once');
        await until(async () => (await registered()).includes('Refused once'), 10_000);
    }, 15_000);
});

describe('REG-9: batches follow the limit the server advertises', () => {
    it('seven misses against a limit of three all land, where one unchunked batch would be refused', async () => {
        // The clone advertises a batch limit of three.
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

describe('REG-10: a registration never reports success for work that did not happen', () => {
    const block = { custom_id: 'b-reg10', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };
    const blockIds = heldBlocks;

    it('from a session the API computes read-only, the skip is a non-success naming "not write-enabled"', async () => {
        await session('k-read');
        expect(writeEnabled.get(), 'the API computed read-only').toBe(false);
        await expect(registerContentBlock(block as never)).resolves.toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(await heldAnywhere()).not.toContain('b-reg10');
    });

    it('while the first catalog fetch has failed, the skip names the unavailable catalog', async () => {
        await fx.update(w, { faults: [{ method: 'GET', path: '/translations', times: 1, drop: true }] });
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        await expect(registerContentBlock(block as never)).resolves.toEqual({ status: false, skipped: true, reason: 'catalog-unavailable' });
        expect(await heldAnywhere()).not.toContain('b-reg10');
    });

    it('a refusal on the registration route is a failure distinct from both skips', async () => {
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        await session('k-write');
        const result = await registerContentBlock(block as never);
        expect(result).toMatchObject({ status: false, reason: 'refused' });
        expect(result).not.toHaveProperty('skipped', true);
        expect(await heldAnywhere()).not.toContain('b-reg10');
    });

    it('a write-enabled registration returns success, and the block is in the next catalog read', async () => {
        await session('k-write');
        await expect(registerContentBlock(block as never)).resolves.toEqual({ status: true });
        expect(await blockIds()).toContain('b-reg10');
        await LangsysApp.refresh();
        expect(isContentBlockKnown('UI', 'b-reg10')).toBe(true);
    });
});

describe('One registration request per block in flight', () => {
    const tree = [
        { tag: 'p', children: [{ text: 'Once A' }] },
        { tag: 'p', children: [{ text: 'Once B' }] },
    ];
    const id = generateCustomId('UI', ['Once A', 'Once B']);
    const heldAs = async (customId: string) => (await heldBlocks()).filter((id) => id === customId);

    /**
     * How many registration requests carried the block, read at the transport seam. The API
     * folds a repeat into the block it already holds, so what it serves cannot tell one request from two.
     */
    function countSends(customId: string): () => number {
        const real = globalThis.fetch;
        let sends = 0;
        vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
            if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes(`"custom_id":"${customId}"`)) sends += 1;
            return real(url, init);
        });
        return () => sends;
    }

    /** A page whose binding renders the block through the tree path: `registerBlock` on mount and on every change `t` goes through. */
    async function pageLoad() {
        resetSdk();
        const started = init('es-es');
        const unmount = LangsysApp.Translations.tSignal.subscribe(() => void registerBlock(tree, { category: 'UI' }));
        await started;
        await until(() => currentlyLoadedLocale.get() === 'es-es');
        await sleep(SETTLE_MS);
        unmount();
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('a block mounted as init() starts is sent once, though the page load changes t again before the request answers', async () => {
        const sends = countSends(id);
        await pageLoad();
        expect(await heldAs(id)).toHaveLength(1);
        expect(sends()).toBe(1);
    });

    it('control: a request the fixture fails is not shared with a later t change, which sends the block again', async () => {
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        const sends = countSends(id);
        await pageLoad();
        expect(await heldAs(id)).toHaveLength(1);
        expect(sends()).toBeGreaterThanOrEqual(2);
    });

    it('two registrations of one block before the first answers make one request, and both report its result', async () => {
        await session('k-write');
        const block = { custom_id: 'b-shared', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };
        const sends = countSends('b-shared');
        const results = await Promise.all([registerContentBlock(block as never), registerContentBlock(block as never)]);
        expect(results).toEqual([{ status: true }, { status: true }]);
        expect(sends()).toBe(1);
        expect(await heldAs('b-shared')).toHaveLength(1);
    });

    it('while one is in flight, the same block registered under another project’s credentials sends its own request, and each project then holds the block', async () => {
        await take('two projects');
        // The first project's request is held while the app re-initialises under the second's.
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, delay_ms: IN_FLIGHT_MS }] });
        const block = { custom_id: 'b-two-projects', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };
        await session('k-write');
        const sends = countSends('b-two-projects');
        let firstAnswered = false;
        const first = registerContentBlock(block as never).finally(() => (firstAnswered = true));
        await until(() => sends() === 1);
        await startSession(fx.baseUrl, w.key('k-write-2'), { project: w.project('p2') });
        const second = registerContentBlock(block as never);
        expect(firstAnswered, 'the first project’s request was still in flight').toBe(false);
        expect(await Promise.all([first, second])).toEqual([{ status: true }, { status: true }]);
        // What the API holds first, then the requests that carried it.
        const heldBy = async (role: string, key: string) => Object.keys((await fx.held(w.key(key), w.project(role), 'es-es')).blocks.UI ?? {});
        expect(await heldBy('p1', 'k-write')).toContain('b-two-projects');
        expect(await heldBy('p2', 'k-write-2')).toContain('b-two-projects');
        expect(sends()).toBe(2);
    });

    it('a request answered after a re-init under another project’s credentials marks nothing known there, so the block mounted under that project registers there', async () => {
        await take('two projects');
        // The first project's request is held until the app has re-initialised under the second's.
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, delay_ms: IN_FLIGHT_MS }] });
        await session('k-write');
        const sends = countSends(id);
        const first = registerContentBlock({ custom_id: id, category: 'UI', content: '<p>Once A</p><p>Once B</p>', label: 'x', tokens: ['Once A', 'Once B'] } as never);
        await until(() => sends() === 1);
        await startSession(fx.baseUrl, w.key('k-write-2'), { project: w.project('p2') });
        expect(await first).toEqual({ status: true });
        const knownAfterAnswer = isContentBlockKnown('UI', id);
        void registerBlock(tree, { category: 'UI' });
        await until(async () => Object.keys((await fx.held(w.key('k-write-2'), w.project('p2'), 'es-es')).blocks.UI ?? {}).includes(id));
        expect(knownAfterAnswer, 'the first project’s answer marked nothing known for the second').toBe(false);
    });
});

describe('A registration answered after the catalog changed keeps that catalog’s translations', () => {
    const tree = [
        { tag: 'img', attrs: { alt: 'Picture of {name}', src: '/a.png' } },
        { tag: 'p', children: [{ text: 'A caption' }] },
    ];
    const id = generateCustomId('VAR', ['Picture of {name}', 'A caption']);
    const es = (translation: string) => [{ locale: 'es-es', translation }];
    /** The content as a translator leaves it before the visitor switches language, imported through the API. */
    async function translatorFinishes() {
        const items = [
            { type: 'phrase', category: 'UI', phrase: 'Welcome back', translations: es('Bienvenido de nuevo') },
            {
                type: 'content_block',
                category: 'VAR',
                custom_id: id,
                content: '<img alt="Picture of {name}" src="/a.png"><p>A caption</p>',
                phrases: [
                    { phrase: 'Picture of {name}', translations: es('Imagen de {name}') },
                    { phrase: 'A caption', translations: es('Un pie de foto') },
                ],
            },
        ];
        const res = await fx.api('/translatable-items', { key: w.key('k-write'), body: { project_id: w.project(), translatable_items: items } });
        expect(res.status, 'the import was accepted').toBe(200);
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /**
     * A write session on the base locale registers, and the visitor switches language while the
     * registration is unanswered: a registration request answers only after 800ms, as on a slow
     * network, and the switch's catalog is published in the meantime.
     */
    async function registerThenSwitch(register: () => void) {
        resetSdk();
        const locale = createSignal('en');
        await LangsysApp.init({ projectid: w.project(), key: w.key('k-write'), UserLocaleStore: locale, baseLocale: 'en', apiUrl: fx.baseUrl });
        await until(() => currentlyLoadedLocale.get() === 'en');
        const real = globalThis.fetch;
        vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
            if (String(url).includes('/translatable-items')) await sleep(800);
            return real(url, init);
        });
        register();
        await sleep(500);
        await translatorFinishes();
        locale.set('es-es');
        await until(() => currentlyLoadedLocale.get() === 'es-es');
        await sleep(SETTLE_MS);
    }

    it('a block: the switched catalog’s translation renders, and the registration was answered', async () => {
        await registerThenSwitch(() => void registerBlock(tree, { category: 'VAR', params: { name: 'Ana' } }));
        expect(await heldBlocks('VAR')).toContain(id);
        expect(LangsysApp.Translations.lookupContent('VAR', id, 'A caption')).toBe('Un pie de foto');
        expect(serializeTree(renderBlock(tree, { category: 'VAR', params: { name: 'Ana' } }).nodes)).toBe('<img alt="Imagen de Ana" src="/a.png"><p>Un pie de foto</p>');
    });

    it('a phrase: the switched catalog’s translation renders, and the registration was answered', async () => {
        await registerThenSwitch(() => void t('Welcome back', 'UI'));
        expect(await registered()).toContain('Welcome back');
        expect(t('Welcome back', 'UI')).toBe('Bienvenido de nuevo');
    });
});

describe('WIRE-4: an unreachable catalog degrades, and registers nothing', () => {
    it('with the catalog fetch dropped, t() returns source text and no miss is registered', async () => {
        await fx.update(w, { faults: [{ method: 'GET', path: '/translations', times: 1, drop: true }] });
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        expect(() => t('Known')).not.toThrow();
        expect(t('Known')).toBe('Known');
        t('During the outage');
        await sleep(SETTLE_MS);
        expect(await registeredAnywhere()).not.toContain('During the outage');
        expect(await registered(), 'control: the catalog phrase is still held server-side').toContain('Known');
    });
});

describe('GATE-9: the base-locale gate the handshake sends', () => {
    it('on: a miss in a non-base locale is not registered, although the server would accept it', async () => {
        await take('gated');
        await session('k-write');
        expect(discoveryBaseLocaleOnly.get(), 'read from the handshake').toBe(true);
        t('Gated away');
        await sleep(SETTLE_MS);
        expect(await registeredAnywhere()).not.toContain('Gated away');
    });

    it('on: the same miss at the base locale registers', async () => {
        await take('gated');
        await session('k-write', { locale: 'en' });
        t('At the base locale');
        await until(async () => (await registered()).includes('At the base locale'));
    });

    // The authorize response carries the setting as well as the catalog envelope, and it is
    // the only source during the gap before the catalog lands. A miss in that gap must already
    // be gated; a client reading only the envelope would record it and register it later.
    it('on: a miss before the catalog arrives is already gated by the authorize response', async () => {
        await take('gated');
        await fx.update(w, { faults: [{ method: 'GET', path: '/translations', times: 1, delay_ms: 1500 }] });
        await session('k-write', { awaitCatalog: false });
        expect(discoveryBaseLocaleOnly.get(), 'known from authorize alone').toBe(true);
        t('Before the catalog');
        await until(() => currentlyLoadedLocale.get() === 'es-es');
        await sleep(SETTLE_MS);
        expect(await registeredAnywhere()).not.toContain('Before the catalog');
    });

    it('control: off, a miss before the catalog arrives is registered once it lands', async () => {
        await fx.update(w, { faults: [{ method: 'GET', path: '/translations', times: 1, delay_ms: 1500 }] });
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
        await take('gated');
        await session('k-write');
        const block = { custom_id: 'b-gated', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['Gated A', 'Gated B'] };
        // The skip is awaited: a registration that was sent would have been answered by now.
        await expect(registerContentBlock(block as never)).resolves.toEqual({ status: false, skipped: true, reason: 'base-locale-gate' });
        expect(await heldAnywhere()).not.toContain('b-gated');
    });

    it('control: off, the same block is registered', async () => {
        await session('k-write');
        const block = { custom_id: 'b-open', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['Open A', 'Open B'] };
        await registerContentBlock(block as never);
        expect(await heldBlocks()).toContain('b-open');
    });
});

describe('MARK-3 stamps through registerBlock, against the API', () => {
    const tree = [
        { tag: 'p', children: [{ text: 'Stamped A' }] },
        { tag: 'p', children: [{ text: 'Stamped B' }] },
    ];
    // The blocks the project holds under an id, each with the content it stored, as the owner reads them.
    const heldAs = async (id: string) => (await fx.storedBlocks(w, w.key('k-write'), 'es-es')).filter((b) => b.custom_id === id);

    it('a stamp outside a resolved scope registers once, under its id, with the host’s content', async () => {
        await session('k-write');
        registerBlock(tree, { category: 'UI', id: 'stamp-unresolved' });
        await until(async () => (await heldAs('stamp-unresolved')).length === 1);
        const [held] = await heldAs('stamp-unresolved');
        expect((await catalog()).blocks.UI?.['stamp-unresolved']).toEqual(['Stamped A', 'Stamped B']);
        expect(held!.content).toBe('<p>Stamped A</p><p>Stamped B</p>');
        registerBlock(tree, { category: 'UI', id: 'stamp-unresolved' });
        await sleep(300);
        expect(await heldAs('stamp-unresolved')).toHaveLength(1);
    });

    it('a stamp adopted inside a resolved scope never posts, although the API would accept it', async () => {
        await session('k-write');
        registerBlock(tree, { category: 'UI', customId: 'stamp-resolved' });
        await sleep(SETTLE_MS);
        expect(await heldAnywhere()).not.toContain('stamp-resolved');
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
    // One failure, with a catalog behind it: after the fault the API answers normally. What
    // the test reads is the page — a refetch inside the window would change what `t()` renders.
    const oneFailure = { faults: [{ method: 'GET', path: '/translations', times: 1, status: 500 }] };

    it('inside the window a lookup renders source text, although the server would now answer', async () => {
        await fx.update(w, oneFailure);
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        await LangsysApp.Translations.change('es-es');
        await sleep(ROUND_TRIP_MS);
        expect(t('Known')).toBe('Known');
    });

    it('after the window the next lookup fetches again, and the translation renders', async () => {
        await fx.update(w, oneFailure);
        await session('k-write', { awaitCatalog: false });
        await until(() => catalogUnavailable.get() === true);
        await sleep(failureWindowMs(1) + 200);
        await LangsysApp.Translations.change('es-es');
        await until(() => t('Known') === 'Conocido');
    }, 15_000);
});

describe('OBS-1: an unusable capability is surfaced once', () => {
    const notices = (warn: ReturnType<typeof vi.spyOn>) =>
        warn.mock.calls.map((c) => c.map(String).join(' ')).filter((s) => s.includes('this session cannot write'));

    it('an ip_write key the API refuses warns once however many misses follow', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await take('ipw elsewhere');
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
