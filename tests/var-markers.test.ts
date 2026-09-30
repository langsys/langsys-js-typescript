// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerBlock, renderBlock, serializeTree, tokenizeTree, warnUnrenderedBlock, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { logger } from '../src/logger.js';
import { _resetNotices, settleNotices, warnUnregistered } from '../src/notices.js';
import { Phrase } from '../src/phrase.js';
import { _resetSeededBlocks } from '../src/served-source.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * VAR-1, VAR-3, VAR-7: a value from a variable is a placeholder, never part of a
 * registered phrase. An emitter marks the value (a comment pair, a `data-ls-param`
 * span, or the pair as tree nodes); the reader registers the template once for
 * every value and renders the value back in.
 */

type Item = { type: string; phrase?: string; custom_id?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
let log: ReturnType<typeof vi.fn>;
const live: Array<{ destroy(): void }> = [];
const settle = () => vi.advanceTimersByTimeAsync(600);
const phrases = () => sent.filter((i) => i.type === 'phrase').map((i) => i.phrase);
const blocks = () => sent.filter((i) => i.type === 'content_block').map((i) => (i.phrases ?? []).map((p) => p.phrase));
const misses = () => (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens;

function catalog(entries: Record<string, unknown>, locale = 'es-es') {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set(locale);
}
function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}
function translate(el: Element, options: Record<string, unknown> = {}): Translate {
    const t = new Translate(el as HTMLElement, { category: 'UI', ...options });
    live.push(t);
    return t;
}
const tUI = (...args: unknown[]) => (LangsysApp.Translations.t as unknown as (...a: unknown[]) => string)(...args);

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    _resetSeededBlocks();
    _resetNotices();
    catalog({});
    writeEnabled.set(true);
    LangsysApp.Translations.settle();
    sent = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        sent.push(...(items as Item[]));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
    for (const m of ['warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    log = vi.spyOn(console, 'log').mockImplementation(() => {}) as never;
    vi.useFakeTimers();
});

afterEach(() => {
    for (const x of live) x.destroy();
    live.length = 0;
    misses().length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    logger.debugEnabled = false;
    Object.assign(configStore, { projectid: '', key: '' });
    document.body.innerHTML = '';
});

const COMMENT = (name: string) => `<p>Hello <!--ls:name-->${name}<!--/ls-->, welcome back</p>`;
const ATTRIBUTE = (name: string) => `<p>Hello <span data-ls-param="name">${name}</span>, welcome back</p>`;
const SOURCE = 'Hello {name}, welcome back';

describe('VAR-1: the same sentence for two users registers one phrase, with the placeholder', () => {
    for (const [form, html] of [
        ['comment', COMMENT],
        ['attribute', ATTRIBUTE],
    ] as const) {
        it(`${form} form`, async () => {
            translate(mount(html('Ana')).firstElementChild!);
            translate(mount(html('Luis')).firstElementChild!);
            await settle();
            expect(phrases()).toEqual([SOURCE]);
            expect(JSON.stringify(sent)).not.toMatch(/Ana|Luis/);
        });
    }

    it('control: the same sentence unmarked registers one phrase per value', async () => {
        translate(mount('<p>Hello Ana, welcome back</p>').firstElementChild!);
        translate(mount('<p>Hello Luis, welcome back</p>').firstElementChild!);
        await settle();
        expect(phrases()).toEqual(['Hello Ana, welcome back', 'Hello Luis, welcome back']);
    });
});

describe('VAR-3: a marked sentence renders around the value the framework owns', () => {
    it('in place: the value node is kept, and a later update to it shows', async () => {
        catalog({ [SOURCE]: 'Hola {name}, bienvenida' });
        const p = mount(COMMENT('Ana')).firstElementChild!;
        const value = p.childNodes[2]!;
        translate(p);
        await settle();
        expect(p.textContent).toBe('Hola Ana, bienvenida');
        expect(p.childNodes[2]).toBe(value);
        value.nodeValue = 'Luis';
        expect(p.textContent).toBe('Hola Luis, bienvenida');
        expect(misses()).toEqual([]);
    });

    it('the attribute form, in place', async () => {
        catalog({ [SOURCE]: 'Hola {name}, bienvenida' });
        const p = mount(ATTRIBUTE('Ana')).firstElementChild!;
        translate(p);
        await settle();
        expect(p.innerHTML).toBe('Hola <span data-ls-param="name">Ana</span>, bienvenida');
    });

    it('a translation that moves the value renders the whole sentence', async () => {
        catalog({ [SOURCE]: '{name}, bienvenida de nuevo' });
        const p = mount(COMMENT('Ana')).firstElementChild!;
        translate(p);
        await settle();
        expect(p.textContent).toBe('Ana, bienvenida de nuevo');
    });

    it('back to the base locale shows the source with the value', async () => {
        catalog({ [SOURCE]: '{name}, bienvenida de nuevo' });
        const p = mount(COMMENT('Ana')).firstElementChild!;
        translate(p);
        await settle();
        catalog({}, 'en');
        await settle();
        expect(p.textContent).toBe('Hello Ana, welcome back');
    });

    it('a caller param of the same name wins over the marked value', async () => {
        catalog({ [SOURCE]: '{name}, bienvenida de nuevo' });
        const p = mount(COMMENT('Ana')).firstElementChild!;
        translate(p, { params: { name: 'Zoe' } });
        await settle();
        expect(p.textContent).toBe('Zoe, bienvenida de nuevo');
        // In place too.
        catalog({ [SOURCE]: 'Hola {name}, bienvenida' });
        await settle();
        expect(p.textContent).toBe('Hola Zoe, bienvenida');
    });

    it('a caller param of the same name wins in a whole-sentence render too', async () => {
        catalog({ [SOURCE]: 'Hola {name}, hola de nuevo {name}' });
        const p = mount(COMMENT('Ana')).firstElementChild!;
        translate(p, { params: { name: 'Zoe' } });
        await settle();
        expect(p.textContent).toBe('Hola Zoe, hola de nuevo Zoe');
    });

    it('plural: the value is the param the ICU form chooses by', async () => {
        const source = 'You have {n} items';
        catalog({ [source]: '{n, plural, one {Tienes # artículo} other {Tienes # artículos}}' });
        const p = mount('<p>You have <!--ls:n-->3<!--/ls--> items</p>').firstElementChild!;
        translate(p, { params: { n: 3 } });
        await settle();
        expect(p.textContent).toBe('Tienes 3 artículos');
    });

    it('a block holds a marked sentence as one token, and a slot holding only a marker as its own', async () => {
        translate(mount('<p>Order total</p><p><!--ls:total-->42<!--/ls--></p><p>Paid by <!--ls:name-->Ana<!--/ls--></p>'));
        await settle();
        expect(blocks()).toEqual([['Order total', '{total}', 'Paid by {name}']]);
    });

    it('a unit made only of markers registers nothing', async () => {
        translate(mount('<p><!--ls:name-->Ana<!--/ls--></p>').firstElementChild!);
        await settle();
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });

    it('a served, adopted block with a marked sentence switches locale from its source', async () => {
        const id = 'served-var';
        catalog({ [id]: { 'Hello {name}!': 'Ciao {name}!' } }, 'it-it');
        const p = mount(`<p data-ls-contentblock="${id}" data-ls-resolved="it-it">Ciao <!--ls:name-->Ana<!--/ls-->!</p>`).firstElementChild!;
        translate(p);
        await settle();
        catalog({ [id]: { 'Hello {name}!': 'Bonjour {name}!' } }, 'fr-fr');
        await settle();
        expect(p.textContent).toBe('Bonjour Ana!');
        expect(sent).toEqual([]);
    });
});

describe('VAR-3 in <Phrase>: a marked value is a placeholder in the rich phrase', () => {
    it('registers the template and renders the value back in', async () => {
        const host = mount('<span data-ls-phrase>Based on <!--ls:n-->3<!--/ls--> <b>reviews</b></span>').firstElementChild! as HTMLElement;
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(phrases()).toEqual(['Based on {n} {m0o}reviews{m0c}']);
        catalog({ 'Based on {n} {m0o}reviews{m0c}': 'Basato su {n} {m0o}recensioni{m0c}' });
        await settle();
        expect(host.textContent).toBe('Basato su 3 recensioni');
        expect(host.querySelector('b')!.textContent).toBe('recensioni');
    });

    it('the attribute form is no markup slot', async () => {
        const host = mount('<span data-ls-phrase>Based on <span data-ls-param="n">3</span> <b>reviews</b></span>').firstElementChild! as HTMLElement;
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(phrases()).toEqual(['Based on {n} {m0o}reviews{m0c}']);
    });
});

describe('VAR-3 as tree nodes: the same token, rendered with the typed param', () => {
    const tree = (value: string): BlockNode[] => [
        { tag: 'p', children: [{ text: 'You have ' }, { comment: 'ls:n' }, { text: value }, { comment: '/ls' }, { text: ' items' }] },
    ];

    it('tokenizes to the token the comment form gives', () => {
        expect(tokenizeTree(tree('3'))).toEqual({ tokens: ['You have {n} items'], shape: 'phrase' });
    });

    it('renders the catalog entry with the typed param, keeping the markers', () => {
        catalog({ 'You have {n} items': '{n, plural, one {Tienes # artículo} other {Tienes # artículos}}' });
        const out = renderBlock(tree('1'), { category: 'UI', params: { n: 1 } });
        expect(serializeTree(out.nodes as BlockNode[])).toBe('<p>Tienes 1 artículo<!--ls:n--><!--/ls--></p>');
        const inPlace = renderBlock(tree('3'), { category: 'UI', params: { n: 3 } });
        catalog({ 'You have {n} items': 'Tienes {n} artículos' });
        const kept = renderBlock(tree('3'), { category: 'UI', params: { n: 3 } });
        expect(serializeTree(inPlace.nodes as BlockNode[])).toContain('Tienes 3 artículos');
        expect(serializeTree(kept.nodes as BlockNode[])).toBe('<p>Tienes <!--ls:n-->3<!--/ls--> artículos</p>');
    });

    it('a phrase host served as source keeps its markers, so a reader on the client reads the same phrase', () => {
        const host: BlockNode[] = [
            { tag: 'span', attrs: { 'data-ls-phrase': true }, children: [{ text: 'Based on ' }, { comment: 'ls:n' }, { text: '3' }, { comment: '/ls' }, { text: ' reviews' }] },
        ];
        expect(serializeTree(renderBlock(host, { category: 'UI' }).nodes as BlockNode[])).toBe('<span data-ls-phrase>Based on <!--ls:n-->3<!--/ls--> reviews</span>');
    });

    it('registers the template, and nothing for a unit made only of markers', async () => {
        registerBlock(tree('3'), { category: 'UI' });
        registerBlock([{ tag: 'p', children: [{ comment: 'ls:n' }, { text: '3' }, { comment: '/ls' }] }], { category: 'UI' });
        await settle();
        expect(phrases()).toEqual(['You have {n} items']);
    });
});

describe('VAR-7: register: false renders from the catalog and registers nothing', () => {
    it('Translate, on the phrase and the block path', async () => {
        catalog({ Hello: 'Hola' });
        const one = mount('<p>Hello</p>').firstElementChild!;
        translate(one, { register: false });
        translate(mount('<p>Never A</p><p>Never B</p>'), { register: false });
        translate(mount('<p>Unknown lone</p>').firstElementChild!, { register: false });
        await settle();
        expect(one.textContent).toBe('Hola');
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });

    it('control: the same content without it registers', async () => {
        translate(mount('<p>Never A</p><p>Never B</p>'));
        translate(mount('<p>Unknown lone</p>').firstElementChild!);
        await settle();
        expect(blocks()).toEqual([['Never A', 'Never B']]);
        expect(phrases()).toEqual(['Unknown lone']);
    });

    it('Phrase', async () => {
        const host = mount('<span data-ls-phrase>Kept <b>quiet</b></span>').firstElementChild! as HTMLElement;
        live.push(new Phrase(host, { category: 'UI', register: false }));
        await settle();
        expect(sent).toEqual([]);
    });

    it('registerBlock', async () => {
        registerBlock([{ tag: 'p', children: [{ text: 'Tree A' }] }, { tag: 'p', children: [{ text: 'Tree B' }] }], { category: 'UI', register: false });
        await settle();
        expect(sent).toEqual([]);
    });

    it('nested hosts a walk takes over inherit it', async () => {
        translate(mount('<p>Outer A</p><section data-ls-contentblock><p>Inner A</p><p>Inner B</p></section>'), { register: false });
        await settle();
        expect(sent).toEqual([]);
    });
});

describe('debug notices: once per reason, held until init() knows debug', () => {
    const said = () => log.mock.calls.map((call) => call.join(' '));

    it('a notice raised before init() is said once init() turns debug on', () => {
        warnUnregistered('svelte-transform');
        warnUnregistered('svelte-transform');
        expect(said()).toEqual([]);
        logger.debugEnabled = true;
        settleNotices();
        expect(said().filter((s) => s.includes('svelte-transform'))).toHaveLength(1);
        warnUnregistered('svelte-transform');
        expect(said().filter((s) => s.includes('svelte-transform'))).toHaveLength(1);
    });

    it('in a fresh process, before any init(), a notice is held rather than dropped', async () => {
        vi.resetModules();
        const fresh = await import('../src/notices.js');
        const freshLogger = (await import('../src/logger.js')).logger;
        fresh.warnUnregistered('fresh-reason');
        freshLogger.debugEnabled = true;
        fresh.settleNotices();
        expect(said().filter((s) => s.includes('fresh-reason'))).toHaveLength(1);
    });

    it('and dropped when init() leaves debug off', () => {
        warnUnregistered('dropped-reason');
        settleNotices();
        expect(said()).toEqual([]);
    });

    it('register: false on a DOM class says so once', async () => {
        logger.debugEnabled = true;
        settleNotices();
        translate(mount('<p>A</p>').firstElementChild!, { register: false });
        translate(mount('<p>B</p>').firstElementChild!, { register: false });
        expect(said().filter((s) => s.includes('register: false'))).toHaveLength(1);
    });

    it('the unrendered notice says what its reason means: a variable registers nothing anywhere', () => {
        logger.debugEnabled = true;
        settleNotices();
        warnUnrenderedBlock('variable');
        warnUnrenderedBlock('component');
        expect(said().find((s) => s.includes('variable'))).toMatch(/registers nothing, on the server or the client/);
        expect(said().find((s) => s.includes('(component)'))).toMatch(/registers it after hydration/);
    });
});

describe('t as a template tag', () => {
    it('a value named by its object registers the placeholder phrase and renders the value', async () => {
        const name = 'Ana';
        expect(tUI`Hello ${{ name }}, you have ${{ itemCount: 3 }} items`).toBe('Hello Ana, you have 3 items');
        await settle();
        expect(phrases()).toEqual(['Hello {name}, you have {item_count} items']);
    });

    it('renders the catalog entry for the template', () => {
        catalog({ __uncategorized__: {} });
        sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__', 'Hello {name}': 'Hola {name}' } } as never);
        const name = 'Ana';
        expect(tUI`Hello ${{ name }}`).toBe('Hola Ana');
    });

    it('a value it cannot name is rendered, never registered, and does not throw', async () => {
        const name = 'Ana';
        expect(() => tUI`Hello ${name}`).not.toThrow();
        expect(tUI`Hello ${name}`).toBe('Hello Ana');
        await settle();
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });
});

describe('a marked block registers under the id its placeholder tokens derive', () => {
    it('for every value', async () => {
        translate(mount('<p>Hi <!--ls:name-->Ana<!--/ls--></p><p>Bye</p>'));
        translate(mount('<p>Hi <!--ls:name-->Luis<!--/ls--></p><p>Bye</p>'));
        await settle();
        expect(new Set(sent.filter((i) => i.type === 'content_block').map((i) => i.custom_id))).toEqual(new Set([generateCustomId('UI', ['Hi {name}', 'Bye'])]));
    });
});
