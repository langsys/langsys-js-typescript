// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { applyRendered, blockNodesOf, registerBlock, renderBlock, serializeTree, type BlockNode, type SeededBlock } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { logger } from '../src/logger.js';
import { Phrase } from '../src/phrase.js';
import { createRequestScope } from '../src/request-scope.js';
import { _resetSeededBlocks } from '../src/served-source.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * A host a server rendered from the catalog holds the translation, and the catalog is
 * keyed by source (SRV-4, GATE-10). The DOM classes over it take the source from the
 * scope's seed, or the catalog entry the served text came from, never from the DOM, so
 * a locale switch on the client renders the next locale and not the served one again.
 */

type Item = { type: string; phrase?: string; custom_id?: string };
let sent: Item[] = [];
let warn: ReturnType<typeof vi.fn>;
const live: Array<{ destroy(): void }> = [];
const settle = () => vi.advanceTimersByTimeAsync(600);

const ID = 'srv-block-1';
const IT = { Hello: 'Ciao', Title: 'Titolo', World: 'Mondo' };
const FR = { Hello: 'Bonjour', Title: 'Titre', World: 'Monde' };
const SEED: SeededBlock = { customId: ID, category: 'UI', tokens: ['Hello', 'Title', 'World'], shape: 'block' };
const SERVED = `<section data-ls-contentblock="${ID}" data-ls-resolved="it-it"><p>Ciao</p><p title="Titolo">Mondo</p></section>`;

function catalog(entries: Record<string, unknown>, locale: string) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set(locale);
}
function mount(html: string): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div);
    return div;
}
function translate(el: Element): Translate {
    const t = new Translate(el as HTMLElement, { category: 'UI' });
    live.push(t);
    return t;
}
function phrase(el: Element): Phrase {
    const p = new Phrase(el as HTMLElement, { category: 'UI' });
    live.push(p);
    return p;
}
const texts = (root: Element) => Array.from(root.querySelectorAll('p')).map((p) => [p.textContent, p.getAttribute('title')]);
const misses = () => (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens;

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    _resetSeededBlocks();
    writeEnabled.set(true);
    LangsysApp.Translations.settle();
    sent = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        sent.push(...(items as Item[]));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
    for (const m of ['log', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as never;
    vi.useFakeTimers();
});

afterEach(() => {
    for (const x of live) x.destroy();
    live.length = 0;
    misses().length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    Object.assign(configStore, { projectid: '', key: '' });
    document.body.innerHTML = '';
});

describe('Translate over a served, stamped host renders the next locale from the source', () => {
    it('from the seed a binding registered after init', async () => {
        catalog({ [ID]: IT }, 'it-it');
        registerBlock(SEED);
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        expect(texts(section)).toEqual([['Ciao', null], ['Mondo', 'Titolo']]);
        catalog({ [ID]: FR }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Bonjour', null], ['Monde', 'Titre']]);
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });

    it('from the catalog entry the served text was rendered from, with no seed', async () => {
        catalog({ [ID]: IT }, 'it-it');
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        catalog({ [ID]: FR }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Bonjour', null], ['Monde', 'Titre']]);
    });

    it('to the base locale, where the catalog has no entry, as the source text', async () => {
        catalog({ [ID]: IT }, 'it-it');
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        catalog({}, 'en');
        await settle();
        expect(texts(section)).toEqual([['Hello', null], ['World', 'Title']]);
        expect(sent).toEqual([]);
    });

    it('checks its params against the source, not the served text', async () => {
        const source = 'You have {n} messages';
        catalog({ [ID]: { [source]: 'Hai {n} messaggi' } }, 'it-it');
        const section = mount(`<section data-ls-contentblock="${ID}" data-ls-resolved="it-it"><p>Hai 3 messaggi</p></section>`).querySelector('section')!;
        // The unmatched-param warning is a debug-time check.
        logger.debugEnabled = true;
        try {
            live.push(new Translate(section, { category: 'UI', params: { n: 3 } }));
            await settle();
            catalog({ [ID]: { [source]: 'Vous avez {n} messages' } }, 'fr-fr');
            await settle();
        } finally {
            logger.debugEnabled = false;
        }
        expect(section.textContent).toBe('Vous avez 3 messages');
        expect(warn).not.toHaveBeenCalled();
    });

    it('a text node keeps the whitespace around its token', async () => {
        catalog({ [ID]: IT }, 'it-it');
        const section = mount(`<section data-ls-contentblock="${ID}" data-ls-resolved="it-it"><p> Ciao </p><p title="Titolo">Mondo</p></section>`).querySelector('section')!;
        registerBlock(SEED);
        translate(section);
        await settle();
        catalog({ [ID]: FR }, 'fr-fr');
        await settle();
        expect(section.querySelector('p')!.textContent).toBe(' Bonjour ');
    });

    it('a seed with a different number of tokens than the host is not this host’s: the catalog decides', async () => {
        catalog({ [ID]: IT }, 'it-it');
        registerBlock({ ...SEED, tokens: ['Hello', 'World'] });
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        catalog({ [ID]: FR }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Bonjour', null], ['Monde', 'Titre']]);
    });

    it('two sources the served text could have come from recover neither, and the host keeps its served text', async () => {
        catalog({ [ID]: { ...IT, Hi: 'Ciao' } }, 'it-it');
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        catalog({ [ID]: { ...FR, Hi: 'Salut' } }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Ciao', null], ['Mondo', 'Titolo']]);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('with neither, it keeps its served text and says why once; a seed handed over later recovers it', async () => {
        catalog({}, 'it-it');
        const section = mount(SERVED).querySelector('section')!;
        translate(section);
        await settle();
        expect(warn).not.toHaveBeenCalled();
        catalog({ [ID]: FR }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Ciao', null], ['Mondo', 'Titolo']]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]!.join(' ')).toContain('registerBlock(seededBlock)');
        registerBlock(SEED);
        catalog({ [ID]: { Hello: 'Salut', Title: 'Titre', World: 'Monde' } }, 'fr-fr');
        await settle();
        expect(texts(section)).toEqual([['Salut', null], ['Monde', 'Titre']]);
    });

    it('server to client: the seed a scope rendered recovers its blocks, the nested one included', async () => {
        const inner = generateCustomId('UI', ['B1']);
        const outer = generateCustomId('UI', ['A1', 'A2']);
        const it_ = { [outer]: { A1: 'Ai1', A2: 'Ai2' }, [inner]: { B1: 'Bi1' } };
        const fr = { [outer]: { A1: 'Af1', A2: 'Af2' }, [inner]: { B1: 'Bf1' } };
        const source: BlockNode[] = [
            { tag: 'p', children: [{ text: 'A1' }] },
            { tag: 'p', children: [{ text: 'A2' }] },
            { tag: 'section', attrs: { 'data-ls-contentblock': true }, children: [{ tag: 'p', children: [{ text: 'B1' }] }] },
        ];
        const scope = await createRequestScope({ locale: 'it-it', catalog: { UI: it_ } as never });
        const rendered = scope.run(() => renderBlock(source, { category: 'UI' }));
        const seed = scope.seed();
        expect(Object.keys(seed.blocks).sort()).toEqual([inner, outer].sort());
        const attrs = Object.entries(rendered.hostAttrs).map(([k, v]) => ` ${k}="${v}"`).join('');
        const host = mount(`<div${attrs}>${serializeTree(rendered.nodes as BlockNode[])}</div>`).firstElementChild!;
        expect(host.querySelector('section')!.getAttribute('data-ls-resolved')).toBe('it-it');

        // The client: the served catalog, then the seed, then the DOM classes.
        catalog(it_, 'it-it');
        for (const block of Object.values(seed.blocks)) registerBlock(block);
        translate(host);
        await settle();
        expect(host.textContent).toBe('Ai1Ai2Bi1');
        catalog(fr, 'fr-fr');
        await settle();
        expect(host.textContent).toBe('Af1Af2Bf1');
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });
});

describe('Phrase over a served host renders the next locale from the source phrase', () => {
    it('recovers the phrase from the catalog and registers nothing', async () => {
        catalog({ 'Hello {m0o}world{m0c}': 'Ciao {m0o}mondo{m0c}' }, 'it-it');
        const p = mount('<p data-ls-phrase data-ls-resolved="it-it">Ciao <b>mondo</b></p>').querySelector('p')!;
        const b = p.querySelector('b')!;
        phrase(p);
        await settle();
        catalog({ 'Hello {m0o}world{m0c}': 'Bonjour {m0o}monde{m0c}' }, 'fr-fr');
        await settle();
        expect(p.innerHTML).toBe('Bonjour <b>monde</b>');
        expect(p.querySelector('b')).toBe(b);
        expect(misses()).toEqual([]);
    });

    it('maps a served translation’s reordered elements back to their source slots', async () => {
        const key = 'A {m0o}big{m0c} {m1o}world{m1c}';
        catalog({ [key]: '{m1o}mondo{m1c} {m0o}grande{m0c}' }, 'it-it');
        const p = mount('<p data-ls-phrase data-ls-resolved="it-it"><b>mondo</b> <i>grande</i></p>').querySelector('p')!;
        phrase(p);
        await settle();
        // Starts with an element, as the served order does: the host's first element is
        // slot 1, and writing by place would put slot 0's text into it.
        catalog({ [key]: '{m0o}grand{m0c} {m1o}monde{m1c}' }, 'fr-fr');
        await settle();
        expect(p.innerHTML).toBe('<i>grand</i> <b>monde</b>');
    });
});

describe('Phrase keeps each element on its own slot after a translation reorders them', () => {
    it('a later locale in source order writes each run into its own element', async () => {
        const key = 'A {m0o}big{m0c} {m1o}world{m1c}';
        catalog({ [key]: '{m1o}mundo{m1c} {m0o}grande{m0c}' }, 'es-es');
        const p = mount('<p data-ls-phrase>A <i>big</i> <b>world</b></p>').querySelector('p')!;
        phrase(p);
        await settle();
        expect(p.innerHTML).toBe('<b>mundo</b> <i>grande</i>');
        // The rebuilt elements are known by their slots, so the same order renders in place.
        const b = p.querySelector('b');
        catalog({ [key]: '{m1o}mundo entero{m1c} {m0o}grande{m0c}' }, 'es-es');
        await settle();
        expect(p.innerHTML).toBe('<b>mundo entero</b> <i>grande</i>');
        expect(p.querySelector('b')).toBe(b);
        // Starts with an element, as the served order does: the host's first element is
        // slot 1, and writing by place would put slot 0's text into it.
        catalog({ [key]: '{m0o}grand{m0c} {m1o}monde{m1c}' }, 'fr-fr');
        await settle();
        expect(p.innerHTML).toBe('<i>grand</i> <b>monde</b>');
    });
});

describe('applyRendered', () => {
    it('with self, writes a tree rendered from the host itself into the host, in place', () => {
        catalog({ 'Hello {m0o}world{m0c}': 'Ciao {m0o}mondo{m0c}' }, 'it-it');
        const p = mount('<p data-ls-phrase>Hello <b>world</b></p>').querySelector('p')!;
        const b = p.querySelector('b')!;
        const attrs = Object.fromEntries(Array.from(p.attributes).map((a) => [a.name, a.value]));
        const rendered = renderBlock([{ tag: 'p', attrs, children: blockNodesOf(p) }], { category: 'UI' });
        expect(applyRendered(p, rendered)).toEqual({ applied: false, reason: 'structure' });
        expect(applyRendered(p, rendered, { self: true })).toEqual({ applied: true });
        expect(p.outerHTML).toBe('<p data-ls-phrase="" data-ls-resolved="it-it">Ciao <b>mondo</b></p>');
        expect(p.querySelector('b')).toBe(b);
    });

    it('writes a nested declared host’s id and resolved marker', () => {
        const inner = generateCustomId('UI', ['B1']);
        catalog({ [inner]: { B1: 'Bi1' } }, 'it-it');
        const host = mount('<p>A1</p><p>A2</p><section data-ls-contentblock><p>B1</p></section>');
        const rendered = renderBlock(blockNodesOf(host), { category: 'UI' });
        expect(applyRendered(host, rendered)).toEqual({ applied: true });
        const section = host.querySelector('section')!;
        expect(section.getAttribute('data-ls-contentblock')).toBe(inner);
        expect(section.getAttribute('data-ls-resolved')).toBe('it-it');
        expect(section.textContent).toBe('Bi1');
    });
});
