// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBlock, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale } from '../src/stores.js';
import { Translate } from '../src/translate.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, until } from './helpers/sdk-session.js';

/**
 * The `content` a block registers with, graded against the contract double (spec CONF-2):
 * every assertion reads what the double stored.
 *
 * VAR-1: a marked value is its `{NAME}` placeholder in the content as in the tokens.
 * MARK-4: a nested phrase or block host is a unit of its own, so the enclosing block's
 * content keeps its element and none of what it shows, which is rendered with its own values.
 * On the DOM path (`Translate`) and the tree path (`registerBlock`) alike.
 */

let fx: ContractFixture;
const live: Translate[] = [];
const VALUES = /Ana|A-1042/;

const SEED = {
    projects: [{ id: 'p1', base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local', phrases: [] }],
    keys: [{ key: 'k-write', project: 'p1', type: 'write' }],
};

const OUTER = generateCustomId('UI', ['Hello {name}, welcome back', 'Order {order} has shipped']);
const heldAs = async (id: string) => (await fx.state()).projects.p1.blocks.filter((b) => b.custom_id === id);
const stored = async () => JSON.stringify(await fx.state());

async function client() {
    resetSdk();
    await LangsysApp.init({ projectid: 'p1', key: 'k-write', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
    await until(() => currentlyLoadedLocale.get() === 'es-es');
}

function mount(html: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
    return wrap.firstElementChild as HTMLElement;
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
    resetSdk();
    vi.restoreAllMocks();
});

describe('DOM path: a Translate block over nested hosts a binding renders through the tree path', () => {
    // The page as the binding left it: the nested hosts show their rendered values.
    const PAGE = (nestedMarker: string) =>
        `<div>` +
        `<p>Hello <!--ls:name-->Ana<!--/ls-->, welcome back</p>` +
        `<p>Order <span data-ls-param="order">A-1042</span> has shipped</p>` +
        `<p data-ls-phrase${nestedMarker}>Taken by Ana</p>` +
        `<section data-ls-contentblock${nestedMarker}><img alt="Photo of Ana"><p>Seat 4B</p></section>` +
        `</div>`;

    it('the outer block’s content holds placeholders and empty nested hosts, and no request carried a value', async () => {
        await client();
        const host = mount(PAGE(''));
        const params = { name: 'Ana' };
        void registerBlock([{ text: 'Taken by {name}' }], { category: 'UI', params, host: host.querySelector('[data-ls-phrase]')! });
        void registerBlock(
            [
                { tag: 'img', attrs: { alt: 'Photo of {name}' } },
                { tag: 'p', children: [{ text: 'Seat 4B' }] },
            ],
            { category: 'UI', params, host: host.querySelector('section')! }
        );
        live.push(new Translate(host, { category: 'UI' }));

        await until(async () => (await heldAs(OUTER)).length === 1);
        const [outer] = await heldAs(OUTER);
        expect(outer!.content).toContain('Hello <!--ls:name-->{name}<!--/ls-->, welcome back');
        expect(outer!.content).toContain('<span data-ls-param="order">{order}</span>');
        expect(outer!.content).toContain('<p data-ls-phrase=""></p>');
        expect(outer!.content).toContain('<section data-ls-contentblock=""></section>');
        await until(async () => (await stored()).includes('Photo of {name}'));
        expect(await stored()).not.toMatch(VALUES);
    });

    it('control: unmarked, with the nested hosts opted out, the same text is the block’s own and its content shows it', async () => {
        await client();
        const host = mount(PAGE('="false"').replace('<!--ls:name-->Ana<!--/ls-->', 'Ana').replace('<span data-ls-param="order">A-1042</span>', 'A-1042'));
        live.push(new Translate(host, { category: 'UI' }));

        const id = generateCustomId('UI', ['Hello Ana, welcome back', 'Order A-1042 has shipped', 'Taken by Ana', 'Photo of Ana', 'Seat 4B']);
        await until(async () => (await heldAs(id)).length === 1);
        const [outer] = await heldAs(id);
        expect(outer!.content).toMatch(VALUES);
        expect(outer!.content).toContain('Seat 4B');
    });
});

describe('tree path: registerBlock over its own values and nested hosts', () => {
    const TREE: BlockNode[] = [
        { tag: 'p', children: [{ text: 'Hello ' }, { comment: 'ls:name' }, { text: 'Ana' }, { comment: '/ls' }, { text: ', welcome back' }] },
        { tag: 'p', children: [{ text: 'Order ' }, { tag: 'span', attrs: { 'data-ls-param': 'order' }, children: [{ text: 'A-1042' }] }, { text: ' has shipped' }] },
        { tag: 'p', attrs: { 'data-ls-phrase': true }, children: [{ text: 'Taken by ' }, { comment: 'ls:who' }, { text: 'Ana' }, { comment: '/ls' }] },
        {
            tag: 'section',
            attrs: { 'data-ls-contentblock': true },
            children: [
                { tag: 'h3', children: [{ text: 'Seat for ' }, { comment: 'ls:who' }, { text: 'Ana' }, { comment: '/ls' }] },
                { tag: 'p', children: [{ text: 'Window side' }] },
            ],
        },
        { tag: 'svg', attrs: { viewBox: '0 0 10 10' }, children: [] },
    ];

    it('each block’s content holds placeholders, the outer one empty nested hosts, and no request carried a value', async () => {
        await client();
        void registerBlock(TREE, { category: 'UI' });

        const inner = generateCustomId('UI', ['Seat for {who}', 'Window side']);
        await until(async () => (await heldAs(OUTER)).length === 1 && (await heldAs(inner)).length === 1);
        const [outer] = await heldAs(OUTER);
        expect(outer!.content).toBe(
            '<p>Hello <!--ls:name-->{name}<!--/ls-->, welcome back</p>' +
                '<p>Order <span data-ls-param="order">{order}</span> has shipped</p>' +
                '<p data-ls-phrase></p>' +
                '<section data-ls-contentblock></section>' +
                '<svg viewBox="0 0 10 10"></svg>'
        );
        const [nested] = await heldAs(inner);
        expect(nested!.content).toBe('<h3>Seat for <!--ls:who-->{who}<!--/ls--></h3><p>Window side</p>');
        await until(async () => (await stored()).includes('Taken by {who}'));
        expect(await stored()).not.toMatch(VALUES);
    });
});
