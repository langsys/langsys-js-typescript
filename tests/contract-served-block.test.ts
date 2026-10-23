// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBlock, renderBlock, serializeTree, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { clearSharedCatalogs, createRequestScope } from '../src/request-scope.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale } from '../src/stores.js';
import { Translate } from '../src/translate.js';
import { CLIENT_FLUSH_DEBOUNCE_MS, RETRY_BACKOFF_BASE_MS } from '../src/translations.js';
import seeds, { INNER, OUTER } from './contract-seeds/contract-served-block.js';
import type { World } from './contract-seeds/worlds.js';
import { anyBlock, anyPhrase, startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, sleep, until } from './helpers/sdk-session.js';

/**
 * A block served translated, then hydrated and switched on the client, graded against the
 * API on an SDK test clone (spec CONF-2): the server renders it in a request scope, the page
 * carries the rendered markup, and the browser `Translate` takes it over. Every assertion reads
 * what the API stored or the DOM, never what the SDK sent.
 *
 * GATE-10: a nested host rendered from the catalog is served with its id and resolved marker,
 * so the browser never registers its translated text as source. SRV-4: a locale switch renders
 * the next locale from the source, never from the served text. Each case takes a world of its
 * own from tests/contract-seeds/contract-served-block.ts.
 */

let fx: ContractFixture;
// The clone's answer to a registration, and its catalog serving it, measured well inside this.
const ROUND_TRIP_MS = 800;
// An absence is read once the SDK's flush would have sent and the clone answered, short of the
// retry backoff a refused send waits out.
const SETTLE_MS = CLIENT_FLUSH_DEBOUNCE_MS + ROUND_TRIP_MS;
if (SETTLE_MS >= RETRY_BACKOFF_BASE_MS) throw new Error('the settle window reaches the retry backoff');

const INNER_AS_ITALIAN = generateCustomId('UI', ['Titolo interno', 'Corpo interno']);
let w: World;

/** A fresh world for the case, named to the forwarder from the world's own address. */
async function take(name: Parameters<typeof seeds.take>[0]): Promise<World> {
    w = seeds.take(name);
    await fx.use(w);
    return w;
}

const TREE: BlockNode[] = [
    { tag: 'p', children: [{ text: 'Pricing plans' }] },
    { tag: 'p', children: [{ text: 'Pick one' }] },
    {
        tag: 'section',
        attrs: { 'data-ls-contentblock': true },
        children: [
            { tag: 'h2', children: [{ text: 'Inner title' }] },
            { tag: 'p', children: [{ text: 'Inner body' }] },
        ],
    },
];

// Registrations as the API's catalog serves them, and a block's stored content as the project's owner reads it.
const catalog = () => fx.held(w.key('k-write'), w.project(), 'it-it');
/** The blocks held under UI, where this file's blocks register. */
const heldIds = async () => Object.keys((await catalog()).blocks.UI ?? {}).sort();
/** Every block held, under any category: what an absence or an exact set is checked against. */
const heldAnywhere = async () => anyBlock(await catalog()).sort();
const storedBlocks = () => fx.storedBlocks(w, w.key('k-write'), 'it-it');
const contentOf = async (id: string) => (await storedBlocks()).find((b) => b.custom_id === id)?.content;
const init = (key: string, locale: string, store = createSignal(locale)) =>
    LangsysApp.init({ projectid: w.project(), key: w.key(key), UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });
const live: Translate[] = [];

/** The client session, at `locale`, with the store a locale switch goes through. */
async function client(locale: string) {
    resetSdk();
    const store = createSignal(locale);
    await init('k-write', locale, store);
    await until(() => currentlyLoadedLocale.get() === locale);
    return store;
}

/** The server's render of TREE in `locale`, as the page carries it, and its seed. */
async function serve(locale: string) {
    const scope = await createRequestScope({ locale });
    const rendered = scope.run(() => {
        const out = renderBlock(TREE, { category: 'UI' });
        registerBlock(TREE, { category: 'UI' });
        return out;
    });
    const seed = scope.seed();
    await scope.close();
    const attrs = Object.entries(rendered.hostAttrs).map(([k, v]) => ` ${k}="${v}"`).join('');
    return { html: `<div${attrs}>${serializeTree(rendered.nodes as BlockNode[])}</div>`, seed };
}

/** The custom ids the core's registration requests carry from here on, counted at the transport seam. */
function sentBlockIds(): string[] {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input).includes('/translatable-items') && init?.method === 'POST') {
            for (const item of (JSON.parse(String(init.body)) as { translatable_items?: Array<{ custom_id?: string }> }).translatable_items ?? []) {
                if (item.custom_id) sent.push(item.custom_id);
            }
        }
        return real(input as string, init);
    });
    return sent;
}

function mount(html: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    const host = wrap.firstElementChild as HTMLElement;
    live.push(new Translate(host, { category: 'UI' }));
    return host;
}

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    for (const m of ['log', 'info', 'warn', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
});
afterEach(() => {
    for (const t of live) t.destroy();
    live.length = 0;
    document.body.innerHTML = '';
    clearSharedCatalogs();
    resetSdk();
    vi.restoreAllMocks();
});

describe('GATE-10: a translated block nested in one served as source', () => {
    // The outer block is new, so it is served as source with no resolved marker and the
    // client registers it; the nested block is translated, and only its own markers say so.
    beforeEach(async () => {
        await take('new outer');
    });

    it('the nested host is served with its id and resolved marker, and its Italian text is never registered', async () => {
        await client('it-it');
        const { html } = await serve('it-it');
        expect(html).toContain(`<section data-ls-contentblock="${INNER}" data-ls-resolved="it-it">`);
        mount(html);
        await until(async () => (await heldIds()).includes(OUTER));
        await sleep(SETTLE_MS);
        expect(await heldAnywhere()).toEqual([INNER, OUTER].sort());
    });

    it('control: served with a bare declaration, the client registers the Italian text as source, and the API accepts it', async () => {
        await client('it-it');
        const { html } = await serve('it-it');
        mount(html.replace(`<section data-ls-contentblock="${INNER}" data-ls-resolved="it-it">`, '<section data-ls-contentblock>'));
        await until(async () => (await heldIds()).includes(INNER_AS_ITALIAN));
    });
});

describe('SRV-4: a block served in it-it, hydrated, and switched to de-de on the client', () => {
    it('a switch renders de-de from the source, the seed handed over after init, and still registers nothing', async () => {
        await take('base');
        const store = await client('it-it');
        const { html, seed } = await serve('it-it');
        for (const block of Object.values(seed.blocks)) registerBlock(block);
        const host = mount(html);
        await sleep(SETTLE_MS);
        expect(host.textContent).toBe('Piani tariffariScegline unoTitolo internoCorpo interno');
        store.set('de-de');
        // The catalog lands before the locale does, and the marker follows the locale.
        await until(() => host.getAttribute('data-ls-resolved') === 'de-de');
        expect(host.textContent).toBe('PreispläneWähle einenInnerer TitelInnerer Text');
        expect(host.querySelector('section')!.getAttribute('data-ls-resolved')).toBe('de-de');
        await sleep(SETTLE_MS);
        expect(await heldAnywhere()).toEqual([INNER, OUTER].sort());
    });
});

describe('a seeded registration right after init sends nothing the catalog holds', () => {
    // Observed at the transport seam: a known block sent again is an upsert the API's
    // catalog cannot show. The phrase-shaped case is also visible in the catalog.
    it('neither a known block nor a phrase-shaped block whose id holds its token, although the catalog is still loading', async () => {
        await take('phrase-shaped block');
        resetSdk();
        const posted: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((url: RequestInfo, init?: RequestInit) => {
            if (init?.method === 'POST') posted.push(String(init.body));
            return realFetch(url, init);
        }) as typeof fetch;
        try {
            await init('k-write', 'it-it');
            registerBlock({ customId: INNER, category: 'UI', tokens: ['Inner title', 'Inner body'], shape: 'block' });
            registerBlock({ customId: 'pricing-hero', category: 'UI', tokens: ['Pricing plans'], shape: 'phrase' });
            registerBlock({ customId: 'seeded-new', category: 'UI', tokens: ['New one', 'New two'], shape: 'block', content: '<p>New one</p><p>New two</p>' });
            // Control: the unknown seeded block is sent and held, so the wait would have seen the others.
            await until(async () => (await heldIds()).includes('seeded-new'));
            await sleep(SETTLE_MS);
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(posted.filter((body) => body.includes(INNER) || body.includes('Pricing plans'))).toEqual([]);
        expect(anyPhrase(await catalog())).not.toContain('Pricing plans');
        expect(await contentOf('seeded-new')).toBe('<p>New one</p><p>New two</p>');
    });
});

describe('a seeded block the catalog does not hold registers with the content the server rendered it from', () => {
    // The API stores a block only with its content, which these read as the project's owner does.
    const contents = async () => Object.fromEntries((await storedBlocks()).map((b) => [b.custom_id, b.content]));

    it('the outer and the nested block, each with the content a registration over their nodes sends', async () => {
        await take('no blocks');
        await client('it-it');
        const { seed } = await serve('it-it');
        for (const block of Object.values(seed.blocks)) registerBlock(block);
        await until(async () => (await heldIds()).length === 2);
        const fromSeed = await contents();
        // Control: the same tree registered over its nodes, in a project that holds neither block.
        await take('no blocks');
        await client('it-it');
        registerBlock(TREE, { category: 'UI' });
        await until(async () => (await heldIds()).length === 2);
        expect(fromSeed).toEqual(await contents());
        expect(fromSeed[INNER]).toBe('<h2>Inner title</h2><p>Inner body</p>');
    });

    it('a seeded block with no content registers nothing from the seed; control: with its content, the same block registers', async () => {
        // Each block is a registration of its own, and the API refuses one without content, so
        // what was not sent is counted at the transport seam.
        await take('no blocks');
        await client('it-it');
        const sent = sentBlockIds();
        registerBlock({ customId: 'no-content', category: 'UI', tokens: ['New one', 'New two'], shape: 'block' });
        registerBlock({ customId: 'with-content', category: 'UI', tokens: ['Other one', 'Other two'], shape: 'block', content: '<p>Other one</p><p>Other two</p>' });
        await until(async () => (await heldIds()).includes('with-content'));
        await sleep(SETTLE_MS);
        expect(sent).toEqual(['with-content']);
        expect(await heldAnywhere()).toEqual(['with-content']);
    });

    it('a seeded block with no content is left to its host: the Translate over the host, served as source, registers it with its own content', async () => {
        await take('no blocks');
        await client('it-it');
        const id = generateCustomId('UI', ['Host one', 'Host two']);
        registerBlock({ customId: id, category: 'UI', tokens: ['Host one', 'Host two'], shape: 'block' });
        mount('<div><p>Host one</p><p>Host two</p></div>');
        await until(async () => (await heldIds()).includes(id));
        expect(await contentOf(id)).toContain('Host one');
    });
});

describe('a block mounted before init() decides once the write capability is known', () => {
    // The hydration order: the page seeds the served catalog, which settles `ready()`,
    // components mount, and only then does the app call init(). Until init answers,
    // `writeEnabled` is unknown, which is not the same as false.
    const NEW_BLOCK = generateCustomId('UI', ['Early one', 'Early two']);
    const mountEarly = () => mount('<div><p>Early one</p><p>Early two</p></div>');

    it('a write key registers it once init() answers', async () => {
        await take('base');
        resetSdk();
        LangsysApp.seedCatalog({ UI: {} } as never, 'it-it');
        mountEarly();
        await sleep(300);
        await init('k-write', 'it-it');
        await until(async () => (await heldIds()).includes(NEW_BLOCK));
        await sleep(SETTLE_MS);
        expect((await heldIds()).filter((id) => id === NEW_BLOCK)).toHaveLength(1);
    });

    it('a read key sends no registration for it', async () => {
        // The API refuses a read key's write itself, so what was not sent is counted at the transport seam.
        await take('base');
        resetSdk();
        const sent = sentBlockIds();
        LangsysApp.seedCatalog({ UI: {} } as never, 'it-it');
        mountEarly();
        await init('k-read', 'it-it');
        await sleep(SETTLE_MS);
        expect(sent).toEqual([]);
        expect(await heldAnywhere()).not.toContain(NEW_BLOCK);
        // Control: the API stores the same block from a session that may write.
        resetSdk();
        document.body.innerHTML = '';
        await init('k-write', 'it-it');
        await until(() => currentlyLoadedLocale.get() === 'it-it');
        mountEarly();
        await until(async () => (await heldIds()).includes(NEW_BLOCK));
    });
});

describe('SRV-5: a Suspense fallback swapped out inside the settle window, against the API', () => {
    // React's vector: a client-rendered <Translate> holding an intro and a lazy child
    // behind <Suspense fallback={<p>Loading spinner</p>}>, the child resolving shortly after.
    const REAL = generateCustomId('UI', ['Intro one', 'Real content']);
    const SPINNER = generateCustomId('UI', ['Intro one', 'Loading spinner']);

    it('holds the block keyed on the real content, never on the spinner', async () => {
        await take('base');
        await client('it-it');
        const wrap = document.createElement('div');
        wrap.innerHTML = '<div><p>Intro one</p><p>Loading spinner</p></div>';
        document.body.appendChild(wrap);
        const host = wrap.firstElementChild as HTMLElement;
        live.push(new Translate(host, { category: 'UI' }));
        await sleep(100);
        const real = document.createElement('p');
        real.textContent = 'Real content';
        host.replaceChild(real, host.lastElementChild!);
        await until(async () => (await heldIds()).includes(REAL));
        await sleep(SETTLE_MS);
        expect(await heldAnywhere()).not.toContain(SPINNER);
        expect((await catalog()).blocks.UI?.[REAL]).toEqual(['Intro one', 'Real content']);
    });
});
