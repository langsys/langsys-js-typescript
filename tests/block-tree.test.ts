// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { applyRendered, blockNodesOf, registerBlock, renderBlock, serializeTree, tokenizeTree, warnUnrenderedBlock, type BlockNode, type RenderedNode } from '../src/block-tree.js';
import { Phrase } from '../src/phrase.js';
import { findSingleTextNode, generateCustomId, tokenizeElement } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { logger } from '../src/logger.js';
import { _resetNotices, settleNotices } from '../src/notices.js';
import { createRequestScope } from '../src/request-scope.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';
import canonicalization from './fixtures/canonicalization-reference.json';
import customIds from './fixtures/custom-id-reference.json';
import tokenizer from './fixtures/tokenizer-reference.json';

/**
 * The tree path (SRV-1, MARK-1, TOK-6 without a DOM): `tokenizeTree`, `renderBlock` and
 * `registerBlock` over `BlockNode` trees, held to the DOM path they must agree with. Every
 * shared vector row with markup is parsed by happy-dom, converted to a tree, and must yield
 * the tokens, shape and id `tokenizeElement` and `Translate` derive from the same DOM.
 */

function toTree(nodes: ArrayLike<ChildNode>): BlockNode[] {
    const out: BlockNode[] = [];
    for (const node of Array.from(nodes)) {
        if (node.nodeType === 3) out.push({ text: node.nodeValue ?? '' });
        else if (node.nodeType === 8) out.push({ comment: node.nodeValue ?? '' });
        else if (node.nodeType === 1) {
            const el = node as Element;
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
            const children = el.localName === 'template' ? (el as HTMLTemplateElement).content.childNodes : el.childNodes;
            out.push({ tag: el.localName, attrs, children: toTree(children) });
        }
    }
    return out;
}

const host = (html: string) => {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
};
const domShape = (div: HTMLElement, tokens: string[]) =>
    tokens.length === 0 ? 'empty' : tokens.length === 1 && findSingleTextNode(div as never) !== null ? 'phrase' : 'block';

const ROWS: Array<{ id: string; html: string; category: string }> = [
    ...(canonicalization as unknown as { cases: Array<{ id: string; html: string; category: string }> }).cases,
    ...(tokenizer as unknown as Array<{ description: string; html: string; category: string }>).map((r) => ({ id: r.description, html: r.html, category: r.category })),
];

describe('parity: a tree tokenizes, shapes and derives its id exactly as the DOM it mirrors', () => {
    it('carries every markup row of the shared vector files', () => {
        expect(ROWS).toHaveLength(49);
    });

    it.each(ROWS.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        const div = host(row.html);
        const dom = tokenizeElement(div).tokens;
        const tree = tokenizeTree(toTree(div.childNodes));
        expect(tree.tokens).toEqual(dom);
        expect(tree.shape).toBe(domShape(div, dom));
        expect(generateCustomId(row.category, tree.tokens)).toBe(generateCustomId(row.category, dom));
    });

    it.each((customIds as unknown as Array<{ category: string; tokens: string[]; custom_id: string }>).map((r, i) => [i, r] as const))(
        'custom-id row %s: the id a tree derives is the shared id',
        (_i, row) => {
            expect(generateCustomId(row.category, row.tokens)).toBe(row.custom_id);
        }
    );

    it('a data-hk attribute (Solid) never enters tokens or the id, on either path; a TOK-3 data-* attribute does', () => {
        const plain = '<p>Hello <b>there</b></p>';
        const marked = '<p data-hk="0-1-2">Hello <b data-hk="0-1-3">there</b></p>';
        const ids = [plain, marked].map((html) => {
            const div = host(html);
            expect(tokenizeTree(toTree(div.childNodes)).tokens).toEqual(tokenizeElement(div).tokens);
            return generateCustomId('UI', tokenizeElement(div).tokens);
        });
        expect(ids[1]).toBe(ids[0]);
        // Positive control: a data-* attribute TOK-3 lists is a token on both paths.
        const confirm = host('<button data-confirm="Sure?">Go</button>');
        expect(tokenizeElement(confirm).tokens).toEqual(['Sure?', 'Go']);
        expect(tokenizeTree(toTree(confirm.childNodes)).tokens).toEqual(['Sure?', 'Go']);
    });

    it('a comment is zero-width and never a token, but text nodes it separates stay separate tokens, as on the DOM', () => {
        const div = host('You have <!--$-->3<!--/--> items');
        const tree = tokenizeTree(toTree(div.childNodes));
        expect(tree.tokens).toEqual(tokenizeElement(div).tokens);
        expect(tree.tokens).toEqual(['You have', '3', 'items']);
        expect(tree.shape).toBe('block');
    });
});

// ---------------------------------------------------------------------

type Item = { type: string; phrase?: string; custom_id?: string; content?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Translate[] = [];
const settle = () => vi.advanceTimersByTimeAsync(600);

function catalog(entries: Record<string, unknown>, locale = 'es-es') {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set(locale);
}
const html = (nodes: RenderedNode[]) => serializeTree(nodes as BlockNode[]);

function withSdk() {
    beforeEach(() => {
        Object.assign(configStore, { projectid: 'p', key: 'k' });
        _resetDiscoveryState();
        writeEnabled.set(true);
        LangsysApp.Translations.settle();
        sent = [];
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
            sent.push(...(items as Item[]));
            return { status: true } as never;
        });
        vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
        for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
            vi.spyOn(console, m).mockImplementation(() => {});
        }
        vi.useFakeTimers();
    });
    afterEach(() => {
        for (const x of live) x.destroy();
        live.length = 0;
        (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens = [];
        vi.useRealTimers();
        vi.restoreAllMocks();
        writeEnabled.set(undefined);
        Object.assign(configStore, { projectid: '', key: '' });
        document.body.innerHTML = '';
    });
}

/** Render `markup` with the DOM class and with the tree path, over the same catalog. */
async function bothPaths(markup: string, entries: Record<string, unknown>, params?: Record<string, string | number>) {
    catalog(entries);
    const div = host(markup);
    const tree = toTree(div.childNodes);
    document.body.appendChild(div);
    live.push(new Translate(div, { category: 'UI', params }));
    await settle();
    const rendered = renderBlock(tree, { category: 'UI', params });
    return { dom: div.innerHTML, domId: div.getAttribute('data-ls-contentblock'), tree: html(rendered.nodes), rendered };
}

describe('renderBlock renders what the DOM class renders, byte for byte', () => {
    withSdk();

    it('a block translated from its catalog entry, with its stamp', async () => {
        const id = generateCustomId('UI', ['One', 'Two']);
        const out = await bothPaths('<p>One</p><p>Two</p>', { [id]: { One: 'Uno', Two: 'Dos' } });
        expect(out.tree).toBe(out.dom);
        expect(out.tree).toBe('<p>Uno</p><p>Dos</p>');
        // Rendered from the catalog in a non-base locale: the id and the resolved marker.
        expect(out.rendered.hostAttrs).toEqual({ 'data-ls-contentblock': id, 'data-ls-resolved': 'es-es' });
        expect(out.rendered.customId).toBe(out.domId);
    });

    it('a single-token unit, as a phrase', async () => {
        const out = await bothPaths('<p>Hello</p>', { Hello: 'Hola' });
        expect(out.rendered.shape).toBe('phrase');
        expect(out.tree).toBe(out.dom);
        expect(out.tree).toBe('<p>Hola</p>');
    });

    it('attributes and params', async () => {
        const id = generateCustomId('UI', ['Search', 'Hi {name}', 'Go']);
        const out = await bothPaths('<input placeholder="Search"><p>Hi {name}</p><button>Go</button>', { [id]: { Search: 'Buscar', 'Hi {name}': 'Hola {name}', Go: 'Ir' } }, { name: 'Ada' });
        expect(out.tree).toBe(out.dom);
        expect(out.tree).toContain('placeholder="Buscar"');
        expect(out.tree).toContain('Hola Ada');
    });

    it('source text when the catalog holds nothing', async () => {
        const out = await bothPaths('<p>Alpha</p><p>Beta</p>', {});
        expect(out.tree).toBe(out.dom);
    });

    it('excluded and code content is returned as given', async () => {
        const id = generateCustomId('UI', ['One', 'Two']);
        const out = await bothPaths('<p>One</p><p>Two</p><style>One</style><span translate="no">One</span>', { [id]: { One: 'Uno', Two: 'Dos' } });
        expect(out.tree).toBe(out.dom);
        expect(out.tree).toContain('<style>One</style>');
    });

    it('every element names its input element by pre-order index, even where a translation reorders markup', () => {
        catalog({ 'Hello {m0o}world{m0c}': '{m0o}mundo{m0c} hola' });
        const tree: BlockNode[] = [{ tag: 'p', attrs: { 'data-ls-phrase': true }, children: [{ text: 'Hello ' }, { tag: 'b', children: [{ text: 'world' }] }] }];
        const out = renderBlock(tree, { category: 'UI' });
        const p = out.nodes[0] as Extract<RenderedNode, { tag: string }>;
        expect(p.source).toBe(0);
        const b = p.children[0] as Extract<RenderedNode, { tag: string }>;
        expect(b.tag).toBe('b');
        expect(b.source).toBe(1);
        // Marked resolved: the text is the catalog's translation (GATE-10).
        expect(html(out.nodes)).toBe('<p data-ls-phrase data-ls-resolved="es-es"><b>mundo</b> hola</p>');
    });

    it('a comment is returned in place, untouched', () => {
        catalog({});
        const out = renderBlock([{ text: 'You have ' }, { comment: '$' }, { text: '3' }, { comment: '/' }, { text: ' items' }], { category: 'UI' });
        expect(html(out.nodes)).toBe('You have <!--$-->3<!--/--> items');
    });

    it('a single-token unit renders without recording a miss either', () => {
        catalog({});
        renderBlock([{ tag: 'p', children: [{ text: 'Lone and unknown' }] }], { category: 'UI' });
        expect((LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens).toEqual([]);
    });

    it('is synchronous and registers nothing', () => {
        catalog({});
        const result = renderBlock([{ tag: 'p', children: [{ text: 'Never registered' }] }, { tag: 'p', children: [{ text: 'By rendering' }] }], { category: 'UI' });
        expect(result).not.toBeInstanceOf(Promise);
        expect((LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens).toEqual([]);
    });
});

describe('MARK-2, MARK-3, MARK-4 on a tree', () => {
    withSdk();

    it('a nested declared block renders as its own block, stamped with its id and resolved marker, and is not in the enclosing block', async () => {
        const inner = generateCustomId('UI', ['B1', 'B2']);
        const outer = generateCustomId('UI', ['A1', 'A2']);
        catalog({ [inner]: { B1: 'Be1', B2: 'Be2' }, [outer]: { A1: 'Ae1', A2: 'Ae2' } });
        const out = renderBlock(toTree(host('<p>A1</p><p>A2</p><section data-ls-contentblock><p>B1</p><p>B2</p></section>').childNodes), { category: 'UI' });
        expect(out.customId).toBe(outer);
        expect(html(out.nodes)).toBe(`<p>Ae1</p><p>Ae2</p><section data-ls-contentblock="${inner}" data-ls-resolved="es-es"><p>Be1</p><p>Be2</p></section>`);
    });

    it('a stamped nested host renders under its id and registers nothing', async () => {
        catalog({ abc123: { B1: 'Uno' } });
        const tree = toTree(host('<p>A1</p><p>A2</p><section data-langsys-contentblock="abc123"><p>B1</p></section>').childNodes);
        expect(html(renderBlock(tree, { category: 'UI' }).nodes)).toContain('<section data-langsys-contentblock="abc123" data-ls-resolved="es-es"><p>Uno</p></section>');
        registerBlock(tree, { category: 'UI' });
        await settle();
        expect(sent.map((i) => i.custom_id ?? i.phrase)).toEqual([generateCustomId('UI', ['A1', 'A2'])]);
    });

    it('an adopted top-level id renders under it and registers nothing', async () => {
        catalog({ abc123: { Hello: 'Hola' } });
        const tree: BlockNode[] = [{ tag: 'p', children: [{ text: 'Hello' }] }];
        const out = renderBlock(tree, { category: 'UI', customId: 'abc123' });
        expect(out.shape).toBe('block');
        expect(html(out.nodes)).toBe('<p>Hola</p>');
        registerBlock(tree, { category: 'UI', customId: 'abc123' });
        await settle();
        expect(sent).toEqual([]);
    });

    it('false and 0 opt out: the element is ordinary markup of the enclosing block', () => {
        const out = tokenizeTree(toTree(host('<p>A1</p><section data-ls-contentblock="0"><p>B1</p></section>').childNodes));
        expect(out.tokens).toEqual(['A1', 'B1']);
    });
});

describe('registerBlock registers what Translate registers, with no DOM', () => {
    withSdk();

    it('an unknown block registers once under its derived id, with its tokens; a phrase host inside registers whole', async () => {
        catalog({});
        const tree = toTree(host('<p>A1</p><p>A2</p><span data-ls-phrase>Kept <b>together</b></span>').childNodes);
        registerBlock(tree, { category: 'UI' });
        await settle();
        const block = sent.find((i) => i.type === 'content_block')!;
        expect(block.custom_id).toBe(generateCustomId('UI', ['A1', 'A2']));
        expect(block.phrases!.map((p) => p.phrase)).toEqual(['A1', 'A2']);
        expect(sent.filter((i) => i.type === 'phrase').map((i) => i.phrase)).toEqual(['Kept {m0o}together{m0c}']);
    });

    it('a single-token unit records its phrase miss', async () => {
        catalog({});
        registerBlock([{ tag: 'p', children: [{ text: 'Lonely' }] }], { category: 'UI' });
        await settle();
        expect(sent.map((i) => i.phrase)).toEqual(['Lonely']);
    });

    it('a known block registers nothing', async () => {
        const id = generateCustomId('UI', ['A1', 'A2']);
        catalog({ [id]: { A1: 'x', A2: 'y' } });
        registerBlock(toTree(host('<p>A1</p><p>A2</p>').childNodes), { category: 'UI' });
        await settle();
        expect(sent).toEqual([]);
    });

    it('inside a request scope the block is deferred to close(), and renderBlock reads the scope', async () => {
        vi.useRealTimers();
        const id = generateCustomId('UI', ['A1', 'A2']);
        const scope = await createRequestScope({ locale: 'de', catalog: { UI: { [id]: { A1: 'Ah1', A2: 'Ah2' } } } as never });
        const tree = toTree(host('<p>A1</p><p>A2</p>').childNodes);
        expect(scope.run(() => html(renderBlock(tree, { category: 'UI' }).nodes))).toBe('<p>Ah1</p><p>Ah2</p>');
        const unknown = toTree(host('<p>New1</p><p>New2</p>').childNodes);
        scope.run(() => registerBlock(unknown, { category: 'UI' }));
        expect(sent).toEqual([]);
    });
});

describe('host attributes: resolved only when the text served came from the catalog', () => {
    withSdk();

    it('a block the catalog lacks is served as source: its id, no resolved marker', () => {
        catalog({});
        const out = renderBlock(toTree(host('<p>New1</p><p>New2</p>').childNodes), { category: 'UI' });
        expect(out.hostAttrs).toEqual({ 'data-ls-contentblock': generateCustomId('UI', ['New1', 'New2']) });
    });

    it('at the base locale, no resolved marker even from the catalog', () => {
        const id = generateCustomId('UI', ['One', 'Two']);
        catalog({ [id]: { One: 'One', Two: 'Two' } }, configStore.baseLocale);
        expect(renderBlock(toTree(host('<p>One</p><p>Two</p>').childNodes), { category: 'UI' }).hostAttrs).toEqual({ 'data-ls-contentblock': id });
    });

    it('a phrase from the catalog carries it; a phrase served as source does not', () => {
        catalog({ Hello: 'Hola' });
        expect(renderBlock([{ tag: 'p', children: [{ text: 'Hello' }] }], { category: 'UI' }).hostAttrs['data-ls-resolved']).toBe('es-es');
        expect(renderBlock([{ tag: 'p', children: [{ text: 'Unknown' }] }], { category: 'UI' }).hostAttrs['data-ls-resolved']).toBeUndefined();
    });
});

describe('BlockOptions.id: the app’s id, rendered and registered under, with content', () => {
    withSdk();

    it('renders under the app id and registers it once with its content', async () => {
        catalog({});
        const tree = toTree(host('<p>A1</p><p>A2</p>').childNodes);
        expect(renderBlock(tree, { category: 'UI', id: 'app-id' }).customId).toBe('app-id');
        registerBlock(tree, { category: 'UI', id: 'app-id' });
        await settle();
        expect(sent.map((i) => i.custom_id)).toEqual(['app-id']);
        expect(sent[0]!.content).toBe('<p>A1</p><p>A2</p>');
    });

    it('control: customId adopts and registers nothing', async () => {
        catalog({});
        registerBlock(toTree(host('<p>A1</p><p>A2</p>').childNodes), { category: 'UI', customId: 'app-id' });
        await settle();
        expect(sent).toEqual([]);
    });
});

describe('MARK-3 on a tree: a stamp adopts only inside a resolved scope', () => {
    withSdk();

    it('a nested stamp alone registers under its id with the host’s content', async () => {
        catalog({});
        registerBlock(toTree(host('<p>A1</p><p>A2</p><section data-ls-contentblock="abc123"><p>B1</p><p>B2</p></section>').childNodes), { category: 'UI' });
        await settle();
        const stamped = sent.filter((i) => i.custom_id === 'abc123');
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.content).toBe('<p>B1</p><p>B2</p>');
    });

    it.each([
        ['on the stamped host', '<section data-ls-contentblock="abc123" data-ls-resolved="es-es"><p>B1</p><p>B2</p></section>'],
        ['on an ancestor in the tree', '<div data-ls-resolved="es-es"><section data-ls-contentblock="abc123"><p>B1</p><p>B2</p></section></div>'],
    ])('with the resolved marker %s: nothing registered for it, and its catalog entry renders', async (_where, inner) => {
        catalog({ abc123: { B1: 'Uno', B2: 'Dos' } });
        const tree = toTree(host(`<p>A1</p><p>A2</p>${inner}`).childNodes);
        expect(html(renderBlock(tree, { category: 'UI' }).nodes)).toContain('<p>Uno</p><p>Dos</p>');
        // With nothing in the catalog, so only the resolved scope can keep it from registering.
        catalog({});
        registerBlock(tree, { category: 'UI' });
        await settle();
        expect(sent.filter((i) => i.custom_id === 'abc123')).toEqual([]);
    });

    it('a nested host names its own category with data-ls-category', async () => {
        catalog({});
        registerBlock(toTree(host('<p>A1</p><p>A2</p><section data-ls-contentblock data-ls-category="Footer"><p>B1</p><p>B2</p></section>').childNodes), { category: 'UI' });
        await settle();
        const inner = sent.find((i) => i.custom_id === generateCustomId('Footer', ['B1', 'B2']));
        expect(inner).toBeDefined();
    });
});

describe('registerBlock’s host: GATE-10 from the host’s parent', () => {
    withSdk();

    it('a host whose parent sits in a resolved scope registers nothing', async () => {
        catalog({});
        const page = host('<article data-ls-resolved="es-es"><div id="h"><p>A1</p><p>A2</p></div></article>');
        const el = page.querySelector('#h')!;
        registerBlock(blockNodesOf(el), { category: 'UI', host: el });
        await settle();
        expect(sent).toEqual([]);
    });

    it('control: the same host outside it registers, even carrying the marker itself', async () => {
        catalog({});
        const page = host('<article><div id="h" data-ls-resolved="es-es"><p>A1</p><p>A2</p></div></article>');
        const el = page.querySelector('#h')!;
        registerBlock(blockNodesOf(el), { category: 'UI', host: el });
        await settle();
        expect(sent.map((i) => i.custom_id)).toEqual([generateCustomId('UI', ['A1', 'A2'])]);
    });
});

describe('blockNodesOf and applyRendered: the DOM helpers', () => {
    withSdk();

    it('blockNodesOf is the tree a host holds', () => {
        const div = host('<p title="T">Hi <b>there</b></p><!--c-->');
        expect(blockNodesOf(div)).toEqual(toTree(div.childNodes));
    });

    it('applyRendered writes text and attributes into the nodes already there, and stamps the host', () => {
        const id = generateCustomId('UI', ['Search', 'One', 'Two']);
        catalog({ [id]: { Search: 'Buscar', One: 'Uno', Two: 'Dos' } });
        const div = host('<input placeholder="Search"><p>One</p><p>Two</p>');
        const text = div.querySelectorAll('p')[1]!.firstChild!;
        const result = applyRendered(div, renderBlock(blockNodesOf(div), { category: 'UI' }));
        expect(result).toEqual({ applied: true });
        expect(div.querySelectorAll('p')[1]!.firstChild).toBe(text);
        expect(text.nodeValue).toBe('Dos');
        expect(div.querySelector('input')!.getAttribute('placeholder')).toBe('Buscar');
        expect(div.getAttribute('data-ls-contentblock')).toBe(id);
        expect(div.getAttribute('data-ls-resolved')).toBe('es-es');
    });

    it('two same-tag elements swapped by the translation are refused: only their source order tells them apart', () => {
        catalog({ '{m0o}a{m0c} and {m1o}b{m1c}': '{m1o}B{m1c} y {m0o}A{m0c}' });
        const div = host('<span data-ls-phrase><b>a</b> and <b>b</b></span>');
        const before = div.innerHTML;
        expect(applyRendered(div, renderBlock(blockNodesOf(div), { category: 'UI' }))).toEqual({ applied: false, reason: 'structure' });
        expect(div.innerHTML).toBe(before);
    });

    it('a translation that reorders markup is refused as structure, and nothing is touched', () => {
        catalog({ 'Hello {m0o}world{m0c}': '{m0o}mundo{m0c} hola' });
        const div = host('<span data-ls-phrase>Hello <b>world</b></span>');
        const before = div.innerHTML;
        const rendered = renderBlock(blockNodesOf(div), { category: 'UI' });
        expect(applyRendered(div, rendered)).toEqual({ applied: false, reason: 'structure' });
        expect(div.innerHTML).toBe(before);
    });
});

describe('the DOM classes under a request scope do nothing, and say so once', () => {
    withSdk();

    it('Translate and Phrase register nothing and leave the host as it is', async () => {
        vi.useRealTimers();
        const warn = vi.spyOn(console, 'warn');
        const scope = await createRequestScope({ locale: 'de', catalog: { UI: { Hello: 'Hallo' } } as never });
        const block = host('<p>Alpha</p><p>Beta</p>');
        const phrase = host('Hello');
        scope.run(() => {
            live.push(new Translate(block, { category: 'UI' }));
            live.push(new Phrase(phrase, { category: 'UI' }) as never);
        });
        await new Promise((r) => setTimeout(r, 600));
        expect(sent).toEqual([]);
        expect(scope.misses()).toEqual([]);
        expect(phrase.textContent).toBe('Hello');
        expect(warn.mock.calls.flat().join(' ')).toContain('renderBlock');
    });
});

describe('SRV-1: a block served as source is reported as a debug notice, once per process per reason', () => {
    it('nothing at all with debug off, then once per reason with it on, however often the block renders', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        _resetNotices();
        settleNotices();
        try {
            warnUnrenderedBlock('component-a');
            expect(log).not.toHaveBeenCalled();
            logger.debugEnabled = true;
            for (let i = 0; i < 3; i++) warnUnrenderedBlock('component-a');
            warnUnrenderedBlock('raw-html-a');
            const notices = log.mock.calls.map((call) => call.join(' '));
            expect(notices.filter((n) => n.includes('(component-a)'))).toHaveLength(1);
            expect(notices.filter((n) => n.includes('(raw-html-a)'))).toHaveLength(1);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            logger.debugEnabled = false;
            log.mockRestore();
            warn.mockRestore();
        }
    });
});
