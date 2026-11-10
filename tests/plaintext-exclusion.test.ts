// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerBlock, renderBlock, serializeTree, tokenizeTree, type BlockNode, type RenderedNode } from '../src/block-tree.js';
import { tokenizeElement } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { NON_TRANSLATABLE_ELEMENTS } from '../src/identity.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import * as pure from '../src/pure.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * TOK-1's `<plaintext>` (spec 8.7.1): a document holding a sentence once in ordinary markup and
 * then again after a `<plaintext>` start tag, which runs to the end of the input, yields exactly
 * one phrase, the ordinary one, on every path this core has: the block walk (`tokenizeElement`)
 * and the `Translate` class over it, the tree path (`tokenizeTree`, `renderBlock`,
 * `registerBlock`), and the rich phrase on both (`Phrase`, and a phrase host on the tree path).
 * On render the text after `<plaintext>` comes back as written, and in a rich phrase it is one
 * empty markup pair whose source is restored, with no param filled inside it at any depth.
 *
 * Parsers read a `<plaintext>` body two ways here. A browser makes everything after the start
 * tag one text node; happy-dom, like libxml2 before 2.14, parses it as markup. Every case runs
 * on both, the browser's shape built by hand because happy-dom cannot produce it.
 *
 * What a path registers is read where the core hands it to the API (`createTranslatableItems`):
 * the phrases it computed, every one of them.
 */

const SENTENCE = 'Enable JavaScript';
const TRANSLATED = 'Activa JavaScript';
/** Everything after the start tag, to the end of the input. */
const AFTER = `${SENTENCE}</p><p>${SENTENCE}`;

/**
 * `before`, then a `<plaintext>` start tag and `after`, the rest of the input. `into` names the
 * element `before` leaves open, which the start tag lands in.
 */
type Model = (host: HTMLElement, before: string, after?: string, into?: string) => HTMLElement;

/** As a browser reads it: the rest of the input is one text node of the element. */
const asBrowser: Model = (host, before, after = AFTER, into) => {
    host.innerHTML = before;
    const plaintext = document.createElement('plaintext');
    plaintext.appendChild(document.createTextNode(after));
    (into ? host.querySelector(into)! : host).appendChild(plaintext);
    return host;
};

/** As happy-dom (and libxml2 before 2.14) reads it: the rest of the input parsed as markup. */
const asMarkup: Model = (host, before, after = AFTER) => {
    host.innerHTML = `${before}<plaintext>${after}`;
    return host;
};

const MODELS: Array<[string, Model]> = [
    ['as a browser reads it', asBrowser],
    ['as markup, as happy-dom and libxml2 before 2.14 read it', asMarkup],
];

function toTree(nodes: ArrayLike<ChildNode>): BlockNode[] {
    return Array.from(nodes).flatMap((node): BlockNode[] => {
        if (node.nodeType === 3) return [{ text: node.nodeValue ?? '' }];
        if (node.nodeType === 8) return [{ comment: node.nodeValue ?? '' }];
        if (node.nodeType !== 1) return [];
        const element = node as Element;
        const attrs = Object.fromEntries(Array.from(element.attributes, (a) => [a.name, a.value]));
        return [{ tag: element.localName, attrs, children: toTree(element.childNodes) }];
    });
}

/** A rendered tree without the `source` indices, to compare with the tree it came from. */
function strip(nodes: readonly RenderedNode[]): BlockNode[] {
    return nodes.map((node) => ('tag' in node ? { tag: node.tag, attrs: node.attrs, children: strip(node.children) } : node));
}

type Item = { type: string; phrase?: string; custom_id?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Array<{ destroy(): void }> = [];
// Past the settle window (SRV-5, 500ms) and the flush debounce after it (400ms).
const settle = () => vi.advanceTimersByTimeAsync(1200);
/** Every phrase the core sent for registration, standalone or inside a block. */
const sentPhrases = () => sent.flatMap((item) => (item.phrases ? item.phrases.map((p) => p.phrase) : [item.phrase!]));

function catalog(entries: Record<string, unknown>) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set('es-es');
}

function mount(model: Model, before: string, after?: string, tag = 'div', into?: string): HTMLElement {
    const host = model(document.createElement(tag), before, after, into);
    document.body.appendChild(host);
    return host;
}

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

afterEach(async () => {
    for (const x of live) x.destroy();
    live.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    Object.assign(configStore, { projectid: '', key: '' });
    document.body.innerHTML = '';
});

it('plaintext is one of the excluded elements, on the main entry and on /pure', () => {
    expect(NON_TRANSLATABLE_ELEMENTS).toContain('plaintext');
    expect(pure.NON_TRANSLATABLE_ELEMENTS).toBe(NON_TRANSLATABLE_ELEMENTS);
});

describe.each(MODELS)('a sentence in ordinary markup and again after <plaintext>, %s', (_name, model) => {
    it('the block walk yields exactly one phrase, the ordinary one', () => {
        expect(tokenizeElement(mount(model, `<p>${SENTENCE}</p>`)).tokens).toEqual([SENTENCE]);
    });

    it('the tree path yields exactly one phrase, the ordinary one', () => {
        expect(tokenizeTree(toTree(mount(model, `<p>${SENTENCE}</p>`).childNodes)).tokens).toEqual([SENTENCE]);
    });

    it('Translate registers only the ordinary phrase, and renders the text after <plaintext> as written', async () => {
        catalog({});
        const host = mount(model, `<p>${SENTENCE}</p>`);
        const plaintext = host.querySelector('plaintext')!;
        const written = plaintext.innerHTML;
        live.push(new Translate(host, { category: 'UI' }));
        await settle();
        expect(sentPhrases()).toEqual([SENTENCE]);

        catalog({ [SENTENCE]: TRANSLATED });
        await settle();
        expect(host.querySelector('p')!.textContent).toBe(TRANSLATED);
        expect(host.querySelector('plaintext')).toBe(plaintext);
        expect(plaintext.innerHTML).toBe(written);
        expect(plaintext.textContent).not.toContain(TRANSLATED);
    });

    it('registerBlock registers only the ordinary phrase, and renderBlock returns the text after <plaintext> as written', async () => {
        const tree = toTree(mount(model, `<p>${SENTENCE}</p>`).childNodes);
        catalog({});
        void registerBlock(tree, { category: 'UI' });
        await settle();
        expect(sentPhrases()).toEqual([SENTENCE]);

        catalog({ [SENTENCE]: TRANSLATED });
        const rendered = renderBlock(tree, { category: 'UI' });
        expect(strip(rendered.nodes)).toEqual([{ tag: 'p', attrs: {}, children: [{ text: TRANSLATED }] }, tree[1]]);
    });

    it('a rich phrase holding it is one empty pair: Phrase registers the ordinary sentence and restores the source', async () => {
        catalog({});
        const host = mount(model, SENTENCE, undefined, 'span');
        const plaintext = host.querySelector('plaintext')!;
        const written = plaintext.innerHTML;
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(sentPhrases()).toEqual([`${SENTENCE}{m0o}{m0c}`]);

        catalog({ [`${SENTENCE}{m0o}{m0c}`]: `${TRANSLATED}{m0o}{m0c}` });
        await settle();
        expect(host.firstChild!.nodeValue).toBe(TRANSLATED);
        expect(host.querySelector('plaintext')).toBe(plaintext);
        expect(plaintext.innerHTML).toBe(written);
    });

    it('a rich phrase holding it on the tree path: registers the ordinary sentence and restores the source', async () => {
        const inner = toTree(mount(model, SENTENCE, undefined, 'span').childNodes);
        const tree: BlockNode[] = [{ tag: 'span', attrs: { 'data-ls-phrase': true }, children: inner }];
        catalog({});
        void registerBlock(tree, { category: 'UI' });
        await settle();
        expect(sentPhrases()).toEqual([`${SENTENCE}{m0o}{m0c}`]);

        catalog({ [`${SENTENCE}{m0o}{m0c}`]: `${TRANSLATED}{m0o}{m0c}` });
        const [span] = strip(renderBlock(tree, { category: 'UI' }).nodes) as Array<{ children: BlockNode[] }>;
        expect(span!.children).toEqual([{ text: TRANSLATED }, inner[1]]);
    });
});

describe.each(MODELS)('no param is ever filled inside <plaintext> in a rich phrase, at any depth, %s', (_name, model) => {
    // Inside an author's own exclusion the caller's params are filled, so the same phrase with a
    // `<plaintext>` nested in a `translate="no"` element shows the fill is live beside it.
    const BEFORE = 'Write to {name}<b translate="no">{name} ';
    const AFTER_PARAMS = '{name} %name% <i>{name}</i>';
    const KEY = 'Write to {name}{m0o}{m0c}';
    const params = { name: 'Ana' };

    it('Phrase', async () => {
        catalog({});
        const host = mount(model, BEFORE, AFTER_PARAMS, 'span', 'b');
        const plaintext = host.querySelector('b > plaintext')!;
        const written = plaintext.innerHTML;
        live.push(new Phrase(host, { category: 'UI', params }));
        await settle();
        expect(sentPhrases()).toEqual([KEY]);
        expect(host.firstChild!.nodeValue).toBe('Write to Ana');
        expect(host.querySelector('b')!.firstChild!.nodeValue).toBe('Ana ');
        expect(plaintext.innerHTML).toBe(written);

        catalog({ [KEY]: 'Escribe a {name}{m0o}{m0c}' });
        await settle();
        expect(host.firstChild!.nodeValue).toBe('Escribe a Ana');
        expect(host.querySelector('b')!.firstChild!.nodeValue).toBe('Ana ');
        expect(host.querySelector('plaintext')!.innerHTML).toBe(written);
    });

    it('the tree path', () => {
        const inner = toTree(mount(model, BEFORE, AFTER_PARAMS, 'span', 'b').childNodes);
        const tree: BlockNode[] = [{ tag: 'span', attrs: { 'data-ls-phrase': true }, children: inner }];
        const plaintext = (inner[1] as { children: BlockNode[] }).children[1];
        for (const [entries, lead] of [
            [{}, 'Write to Ana'],
            [{ [KEY]: 'Escribe a {name}{m0o}{m0c}' }, 'Escribe a Ana'],
        ] as const) {
            catalog(entries);
            const [span] = strip(renderBlock(tree, { category: 'UI', params }).nodes) as Array<{ children: BlockNode[] }>;
            expect(span!.children[0]).toEqual({ text: lead });
            const b = span!.children[1] as { children: BlockNode[] };
            expect(b.children[0]).toEqual({ text: 'Ana ' });
            expect(b.children[1]).toEqual(plaintext);
        }
    });
});

describe.each([
    ['as a browser reads it', asBrowser, `${SENTENCE}{m0o}${SENTENCE}</p><p>${SENTENCE}{m0c}`],
    ['as markup, as happy-dom and libxml2 before 2.14 read it', asMarkup, `${SENTENCE}{m0o}${SENTENCE}{m1o}${SENTENCE}{m1c}{m0c}`],
] as const)('a phrase holding <plaintext>, keyed before it was excluded, %s', (_name, model, earlier) => {
    // The key a reader that walked into `<plaintext>` gave the same host: a translation stored
    // under it renders, with the element restored from source, and only the current key registers.
    const KEY = `${SENTENCE}{m0o}{m0c}`;
    const translation = TRANSLATED + earlier.slice(SENTENCE.length);

    it('Phrase', async () => {
        catalog({ [earlier]: translation });
        const host = mount(model, SENTENCE, undefined, 'span');
        const plaintext = host.querySelector('plaintext')!;
        const written = plaintext.innerHTML;
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(host.firstChild!.nodeValue).toBe(TRANSLATED);
        expect(host.querySelector('plaintext')).toBe(plaintext);
        expect(plaintext.innerHTML).toBe(written);
        expect(sentPhrases()).toEqual([KEY]);
    });

    it('the tree path', async () => {
        const inner = toTree(mount(model, SENTENCE, undefined, 'span').childNodes);
        const tree: BlockNode[] = [{ tag: 'span', attrs: { 'data-ls-phrase': true }, children: inner }];
        catalog({ [earlier]: translation });
        const [span] = strip(renderBlock(tree, { category: 'UI' }).nodes) as Array<{ children: BlockNode[] }>;
        expect(span!.children).toEqual([{ text: TRANSLATED }, inner[1]]);
        void registerBlock(tree, { category: 'UI' });
        await settle();
        expect(sentPhrases()).toEqual([KEY]);
    });
});

it('serializes as it was given: a tree path render of the browser shape holds the same text node', () => {
    // The node is returned, not rebuilt: its text, markup characters included, is the source's.
    const tree = toTree(asBrowser(document.createElement('div'), `<p>${SENTENCE}</p>`).childNodes);
    catalog({ [SENTENCE]: TRANSLATED });
    const rendered = renderBlock(tree, { category: 'UI' }).nodes;
    expect((rendered[1] as { children: RenderedNode[] }).children).toEqual([{ text: AFTER }]);
    expect(serializeTree(strip(rendered).slice(1))).toBe(serializeTree(tree.slice(1)));
});
