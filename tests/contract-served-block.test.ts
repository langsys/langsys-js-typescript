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
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, sleep, until } from './helpers/sdk-session.js';

/**
 * A block served translated, then hydrated and switched on the client, graded against the
 * contract double (spec CONF-2): the server renders it in a request scope, the page carries
 * the rendered markup, and the browser `Translate` takes it over. Every assertion reads the
 * double's accepted state or the DOM, never what the SDK sent.
 *
 * GATE-10: a nested host rendered from the catalog is served with its id and resolved marker,
 * so the browser never registers its translated text as source. SRV-4: a locale switch renders
 * the next locale from the source, never from the served text.
 */

let fx: ContractFixture;
const SETTLE_MS = 1200; // past the 400ms flush debounce, short of the 3s backoff

const OUTER = generateCustomId('UI', ['Pricing plans', 'Pick one']);
const INNER = generateCustomId('UI', ['Inner title', 'Inner body']);
const INNER_AS_ITALIAN = generateCustomId('UI', ['Titolo interno', 'Corpo interno']);

const SEED = {
    projects: [
        {
            id: 'p1',
            base_locale: 'en',
            target_locales: ['it-it', 'de-de'],
            website_url: 'https://site.local',
            phrases: [],
            blocks: [
                {
                    category: 'UI',
                    custom_id: OUTER,
                    phrases: [
                        { phrase: 'Pricing plans', translations: { 'it-it': 'Piani tariffari', 'de-de': 'Preispläne' } },
                        { phrase: 'Pick one', translations: { 'it-it': 'Scegline uno', 'de-de': 'Wähle einen' } },
                    ],
                },
                {
                    category: 'UI',
                    custom_id: INNER,
                    phrases: [
                        { phrase: 'Inner title', translations: { 'it-it': 'Titolo interno', 'de-de': 'Innerer Titel' } },
                        { phrase: 'Inner body', translations: { 'it-it': 'Corpo interno', 'de-de': 'Innerer Text' } },
                    ],
                },
            ],
        },
    ],
    keys: [{ key: 'k-write', project: 'p1', type: 'write' }],
};

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

/** The same project without the outer block: new page content around a block already translated. */
const SEED_NEW_OUTER = { ...SEED, projects: [{ ...SEED.projects[0]!, blocks: SEED.projects[0]!.blocks.filter((b) => b.custom_id === INNER) }] };

const heldIds = async () => (await fx.state()).projects.p1.blocks.map((b) => b.custom_id).sort();
const live: Translate[] = [];

/** The client session, at `locale`, with the store a locale switch goes through. */
async function client(locale: string) {
    resetSdk();
    const store = createSignal(locale);
    await LangsysApp.init({ projectid: 'p1', key: 'k-write', UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });
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
    await fx.seed(SEED);
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
        await fx.seed(SEED_NEW_OUTER);
    });

    it('the nested host is served with its id and resolved marker, and its Italian text is never registered', async () => {
        await client('it-it');
        const { html } = await serve('it-it');
        expect(html).toContain(`<section data-ls-contentblock="${INNER}" data-ls-resolved="it-it">`);
        mount(html);
        await until(async () => (await heldIds()).includes(OUTER));
        await sleep(SETTLE_MS);
        expect(await heldIds()).toEqual([INNER, OUTER].sort());
    });

    it('control: served with a bare declaration, the client registers the Italian text as source, and the double accepts it', async () => {
        await client('it-it');
        const { html } = await serve('it-it');
        mount(html.replace(`<section data-ls-contentblock="${INNER}" data-ls-resolved="it-it">`, '<section data-ls-contentblock>'));
        await until(async () => (await heldIds()).includes(INNER_AS_ITALIAN));
    });
});

describe('SRV-4: a block served in it-it, hydrated, and switched to de-de on the client', () => {
    it('a switch renders de-de from the source, the seed handed over after init, and still registers nothing', async () => {
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
        expect(await heldIds()).toEqual([INNER, OUTER].sort());
    });
});
