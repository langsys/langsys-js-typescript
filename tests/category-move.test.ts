// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { applyRendered, blockNodesOf, registerBlock, renderBlock, type BlockNode } from '../src/block-tree.js';
import { inCategory, isCategoryRef } from '../src/category-ref.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { PREVIOUS_CATEGORY_MARKER_ATTR, PREVIOUS_CONTENT_BLOCK_MARKER_ATTR } from '../src/identity.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { createRequestScope } from '../src/request-scope.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * Moving content between categories (spec MOVE-1..MOVE-5).
 *
 * A call or block moved into a new category names the category it was registered under
 * before. That value rides on the registration a miss triggers, and nowhere else; it is
 * never identity; and until the catalog holds the item under its new category, the previous
 * category's entry renders, so the first deploy after a move shows the translation the
 * content had all along rather than its source.
 */

type Item = { type: string; phrase?: string; category?: string | null; previous_category?: string; custom_id?: string };
let sent: Item[] = [];
const live: Array<{ destroy(): void }> = [];
const settle = () => vi.advanceTimersByTimeAsync(600);
const t = (...args: unknown[]) => (LangsysApp.Translations.t as unknown as (...a: unknown[]) => string)(...args);

function catalog(categories: Record<string, Record<string, unknown>>, locale = 'es-cr') {
    const cats: Record<string, unknown> = { __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } };
    for (const [name, entries] of Object.entries(categories)) {
        cats[name] = { __category__: name, __symbol__: name, ...((cats[name] as object) ?? {}), ...entries };
    }
    sTranslations.set(cats as never);
    currentlyLoadedLocale.set(locale);
}

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k', baseLocale: 'en', debug: false });
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
    await vi.advanceTimersByTimeAsync(1000);
    for (const x of live) x.destroy();
    live.length = 0;
    (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    Object.assign(configStore, { projectid: '', key: '', debug: false });
    document.body.innerHTML = '';
});

describe('inCategory()', () => {
    it('brands a ref with a registry symbol, so another copy of the package recognises it', () => {
        const ref = inCategory('Checkout', { previousCategory: 'Header' });
        expect(isCategoryRef(ref)).toBe(true);
        expect((ref as unknown as Record<symbol, unknown>)[Symbol.for('langsys.category')]).toBe(true);
        expect(Object.isFrozen(ref)).toBe(true);
    });

    it('a params object, even one with a `category` key, is never a ref', () => {
        expect(isCategoryRef({ category: 'Checkout', previousCategory: 'Header' })).toBe(false);
        expect(isCategoryRef(null)).toBe(false);
        expect(isCategoryRef('Checkout')).toBe(false);
    });

    it('null, undefined and the current category itself are no move; "" is one', () => {
        expect(inCategory('Checkout', { previousCategory: null }).previousCategory).toBeUndefined();
        expect(inCategory('Checkout', {}).previousCategory).toBeUndefined();
        expect(inCategory('Checkout', { previousCategory: 'Checkout' }).previousCategory).toBeUndefined();
        expect(inCategory('Checkout', { previousCategory: '' }).previousCategory).toBe('');
    });
});

describe('MOVE-1: the previous category travels as previous_category on the item', () => {
    it('names it beside the category', async () => {
        catalog({});
        t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
        await settle();
        expect(sent).toEqual([{ type: 'phrase', phrase: 'Buy now', category: 'Checkout', previous_category: 'Header' }]);
    });

    it('"" is sent as "": the content had no category before', async () => {
        catalog({});
        t('Buy now', inCategory('Checkout', { previousCategory: '' }));
        await settle();
        expect(sent).toEqual([{ type: 'phrase', phrase: 'Buy now', category: 'Checkout', previous_category: '' }]);
    });

    it('control: without it, or with the same category, the item has no previous_category key', async () => {
        catalog({});
        t('Buy now', 'Checkout');
        t('Pay now', inCategory('Checkout', { previousCategory: 'Checkout' }));
        await settle();
        expect(sent).toHaveLength(2);
        for (const item of sent) expect(Object.prototype.hasOwnProperty.call(item, 'previous_category')).toBe(false);
    });

    it('params still follow the ref in position 3', () => {
        catalog({ Checkout: { 'Hi {name}': 'Hola {name}' } });
        expect(t('Hi {name}', inCategory('Checkout', { previousCategory: 'Header' }), { name: 'Ana' })).toBe('Hola Ana');
    });

    it('a Phrase names it on its registration', async () => {
        catalog({});
        const el = document.createElement('p');
        el.innerHTML = 'Read the <b>terms</b>';
        document.body.appendChild(el);
        live.push(new Phrase(el, { category: 'Legal', previousCategory: 'Footer' }));
        await settle();
        expect(sent).toEqual([{ type: 'phrase', phrase: 'Read the {m0o}terms{m0c}', category: 'Legal', previous_category: 'Footer' }]);
    });

    it('a Translate block names it on its registration', async () => {
        catalog({});
        const el = document.createElement('div');
        el.innerHTML = '<p>First</p><p>Second</p>';
        document.body.appendChild(el);
        live.push(new Translate(el, { category: 'Pricing', previousCategory: 'Home' }));
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'content_block', category: 'Pricing', previous_category: 'Home', custom_id: generateCustomId('Pricing', ['First', 'Second']) });
    });

    it('a request scope sends it at close()', async () => {
        Object.assign(configStore, { ssrTokenStrategy: 'server' });
        try {
            const scope = await createRequestScope({ locale: 'es-cr', catalog: {} as never });
            scope.t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
            await scope.close();
            expect(sent).toEqual([{ type: 'phrase', phrase: 'Buy now', category: 'Checkout', previous_category: 'Header' }]);
        } finally {
            Object.assign(configStore, { ssrTokenStrategy: 'client' });
        }
    });
});

describe('MOVE-2: it is never identity', () => {
    it('a block derives the same custom_id with and without it', async () => {
        catalog({});
        const a = document.createElement('div');
        a.innerHTML = '<p>One</p><p>Two</p>';
        const b = document.createElement('div');
        b.innerHTML = '<p>One</p><p>Two</p>';
        document.body.append(a, b);
        live.push(new Translate(a, { category: 'C' }), new Translate(b, { category: 'C', previousCategory: 'Old' }));
        await settle();
        expect(a.getAttribute('data-ls-contentblock')).toBe(b.getAttribute('data-ls-contentblock'));
        expect(a.getAttribute('data-ls-contentblock')).toBe(generateCustomId('C', ['One', 'Two']));
    });

    it('two calls queue one item; the first previous category named stays, and a later absent one never clears it', async () => {
        catalog({});
        t('Buy now', 'Checkout');
        t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
        t('Buy now', inCategory('Checkout', { previousCategory: 'Sidebar' }));
        t('Buy now', 'Checkout');
        await settle();
        expect(sent).toEqual([{ type: 'phrase', phrase: 'Buy now', category: 'Checkout', previous_category: 'Header' }]);
    });
});

describe('MOVE-3: it travels only on the registration a miss triggers', () => {
    it('an item the catalog holds under its current category is not registered again', async () => {
        catalog({ Checkout: { 'Buy now': 'Comprá' } });
        t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
        await settle();
        expect(sent).toEqual([]);
    });

    it('a read-only session sends nothing', async () => {
        writeEnabled.set(false);
        catalog({});
        t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
        await settle();
        expect(sent).toEqual([]);
    });
});

describe('MOVE-4: until the new category is in the catalog, the previous one renders', () => {
    it('renders the previous category’s entry and still registers under the current one', async () => {
        catalog({ Header: { 'Buy now': 'Comprá ya' } });
        expect(t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }))).toBe('Comprá ya');
        await settle();
        expect(sent).toEqual([{ type: 'phrase', phrase: 'Buy now', category: 'Checkout', previous_category: 'Header' }]);
    });

    it('control: without the previous category the same catalog renders source', () => {
        catalog({ Header: { 'Buy now': 'Comprá ya' } });
        expect(t('Buy now', 'Checkout')).toBe('Buy now');
    });

    it('"" reads the no-category bucket, never a literal "" key', () => {
        catalog({ __uncategorized__: { 'Buy now': 'Comprá ya' } });
        expect(t('Buy now', inCategory('Checkout', { previousCategory: '' }))).toBe('Comprá ya');
    });

    it('the current category wins once it holds the item', () => {
        catalog({ Header: { 'Buy now': 'Comprá ya' }, Checkout: { 'Buy now': 'Pagá' } });
        expect(t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }))).toBe('Pagá');
    });

    it('keeps rendering the previous entry after this session registered the item, until a fetch brings its translation', async () => {
        catalog({ Header: { 'Buy now': 'Comprá ya' } });
        t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
        await settle();
        // The registration recorded the phrase under Checkout as known, with no translation.
        expect(Object.prototype.hasOwnProperty.call(sTranslations.get().Checkout ?? {}, 'Buy now')).toBe(true);
        expect(t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }))).toBe('Comprá ya');
        expect(sent).toHaveLength(1);
    });

    it('an empty previous entry falls back to source (CAT-2)', () => {
        catalog({ Header: { 'Buy now': '' } });
        expect(t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }))).toBe('Buy now');
    });

    it('a Phrase renders from the previous category', async () => {
        catalog({ Footer: { 'Read the {m0o}terms{m0c}': 'Leé los {m0o}términos{m0c}' } });
        const el = document.createElement('p');
        el.innerHTML = 'Read the <b>terms</b>';
        document.body.appendChild(el);
        live.push(new Phrase(el, { category: 'Legal', previousCategory: 'Footer' }));
        await settle();
        expect(el.innerHTML).toBe('Leé los <b>términos</b>');
    });

    it('a Translate block renders from the previous category’s custom_id, and registers under the current one', async () => {
        const previousId = generateCustomId('Home', ['First', 'Second']);
        catalog({ Home: { [previousId]: { First: 'Primero', Second: 'Segundo' } } });
        const el = document.createElement('div');
        el.innerHTML = '<p>First</p><p>Second</p>';
        document.body.appendChild(el);
        live.push(new Translate(el, { category: 'Pricing', previousCategory: 'Home' }));
        await settle();
        expect(el.innerHTML).toBe('<p>Primero</p><p>Segundo</p>');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'content_block', category: 'Pricing', previous_category: 'Home', custom_id: generateCustomId('Pricing', ['First', 'Second']) });
    });

    it('control: the same Translate without the previous category renders source', async () => {
        const previousId = generateCustomId('Home', ['First', 'Second']);
        catalog({ Home: { [previousId]: { First: 'Primero', Second: 'Segundo' } } });
        const el = document.createElement('div');
        el.innerHTML = '<p>First</p><p>Second</p>';
        document.body.appendChild(el);
        live.push(new Translate(el, { category: 'Pricing' }));
        await settle();
        expect(el.innerHTML).toBe('<p>First</p><p>Second</p>');
    });

    it('an app-fixed custom_id is read under the same id in the previous category', async () => {
        catalog({ Home: { 'hero-copy': { First: 'Primero', Second: 'Segundo' } } });
        const el = document.createElement('div');
        el.innerHTML = '<p>First</p><p>Second</p>';
        document.body.appendChild(el);
        live.push(new Translate(el, { category: 'Pricing', previousCategory: 'Home', custom_id: 'hero-copy' }));
        await settle();
        expect(el.innerHTML).toBe('<p>Primero</p><p>Segundo</p>');
    });
});

describe('MOVE-5: a host renderBlock filled from the previous category says so', () => {
    const nodes = (html: string): BlockNode[] => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return blockNodesOf(div);
    };

    it('a block carries its current id and the previous category’s id', () => {
        const previousId = generateCustomId('Home', ['First', 'Second']);
        catalog({ Home: { [previousId]: { First: 'Primero', Second: 'Segundo' } } });
        const rendered = renderBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing', previousCategory: 'Home' });
        expect(rendered.customId).toBe(generateCustomId('Pricing', ['First', 'Second']));
        expect(rendered.hostAttrs).toMatchObject({
            'data-ls-contentblock': generateCustomId('Pricing', ['First', 'Second']),
            [PREVIOUS_CONTENT_BLOCK_MARKER_ATTR]: previousId,
            'data-ls-resolved': 'es-cr',
        });
    });

    it('a phrase-shaped unit filled from the previous category’s phrase carries the previous category', () => {
        catalog({ Header: { 'Buy now': 'Comprá ya' } });
        const rendered = renderBlock(nodes('Buy now'), { category: 'Checkout', previousCategory: 'Header' });
        expect(rendered.hostAttrs[PREVIOUS_CATEGORY_MARKER_ATTR]).toBe('Header');
        expect(rendered.nodes).toEqual([{ text: 'Comprá ya' }]);
    });

    it('control: a host filled from its current category carries neither', () => {
        const id = generateCustomId('Pricing', ['First', 'Second']);
        catalog({ Pricing: { [id]: { First: 'Uno', Second: 'Dos' } }, Home: { [generateCustomId('Home', ['First', 'Second'])]: { First: 'X', Second: 'Y' } } });
        const rendered = renderBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing', previousCategory: 'Home' });
        expect(rendered.hostAttrs).not.toHaveProperty(PREVIOUS_CONTENT_BLOCK_MARKER_ATTR);
        expect(rendered.hostAttrs).not.toHaveProperty(PREVIOUS_CATEGORY_MARKER_ATTR);
    });

    it('applyRendered sets the marker, and removes it once the host renders from its current category', () => {
        const previousId = generateCustomId('Home', ['First', 'Second']);
        catalog({ Home: { [previousId]: { First: 'Primero', Second: 'Segundo' } } });
        const host = document.createElement('div');
        host.innerHTML = '<p>First</p><p>Second</p>';
        const source = blockNodesOf(host);
        applyRendered(host, renderBlock(source, { category: 'Pricing', previousCategory: 'Home' }));
        expect(host.getAttribute(PREVIOUS_CONTENT_BLOCK_MARKER_ATTR)).toBe(previousId);
        const id = generateCustomId('Pricing', ['First', 'Second']);
        catalog({ Pricing: { [id]: { First: 'Uno', Second: 'Dos' } } });
        applyRendered(host, renderBlock(source, { category: 'Pricing', previousCategory: 'Home' }));
        expect(host.hasAttribute(PREVIOUS_CONTENT_BLOCK_MARKER_ATTR)).toBe(false);
        expect(host.innerHTML).toBe('<p>Uno</p><p>Dos</p>');
    });

    it('registerBlock sends the previous category', async () => {
        catalog({});
        await registerBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing', previousCategory: 'Home' });
        await settle();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'content_block', category: 'Pricing', previous_category: 'Home' });
    });
});

describe('MOVE-1: a move one call makes while another still uses the old category is said once (debug)', () => {
    it('warns once per phrase and category', () => {
        Object.assign(configStore, { debug: true });
        LangsysApp.Translations.debug.debugEnabled = true;
        try {
            catalog({});
            const warn = vi.spyOn(LangsysApp.Translations.debug, 'warn');
            t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));
            t('Buy now', 'Header');
            t('Buy now', 'Header');
            const split = warn.mock.calls.filter(([m]) => String(m).includes('moved out of category'));
            expect(split).toHaveLength(1);
        } finally {
            LangsysApp.Translations.debug.debugEnabled = false;
        }
    });
});

describe('review fixes: a later record without the move never drops it', () => {
    const nodes = (html: string): BlockNode[] => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return blockNodesOf(div);
    };

    it('a request scope keeps a block’s previous category when the same block is recorded again without one', async () => {
        Object.assign(configStore, { ssrTokenStrategy: 'server' });
        try {
            const scope = await createRequestScope({ locale: 'es-cr', catalog: {} as never });
            // Both inside the scope synchronously: without an AsyncLocalStorage a scope does
            // not survive an await.
            scope.run(() => {
                void registerBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing', previousCategory: 'Home' });
                void registerBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing' });
            });
            await scope.close();
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ type: 'content_block', category: 'Pricing', previous_category: 'Home' });
        } finally {
            Object.assign(configStore, { ssrTokenStrategy: 'client' });
        }
    });

    it('its seed keeps the previous category across a second render without one', async () => {
        const scope = await createRequestScope({ locale: 'es-cr', catalog: {} as never });
        scope.run(() => {
            renderBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing', previousCategory: 'Home' });
            renderBlock(nodes('<p>First</p><p>Second</p>'), { category: 'Pricing' });
        });
        const [block] = Object.values(scope.seed().blocks);
        expect(block?.previousCategory).toBe('Home');
    });

    it('a nested phrase host re-rendered from live DOM loses its stamp once its current category has the translation', () => {
        const phrase = 'Read the {m0o}terms{m0c}';
        catalog({ Footer: { [phrase]: 'Leé los {m0o}términos{m0c}' } });
        const host = document.createElement('div');
        host.innerHTML = '<p>Intro</p><span data-ls-phrase>Read the <b>terms</b></span>';
        applyRendered(host, renderBlock(blockNodesOf(host), { category: 'Legal', previousCategory: 'Footer' }));
        const nested = host.querySelector('span')!;
        expect(nested.getAttribute(PREVIOUS_CATEGORY_MARKER_ATTR)).toBe('Footer');
        catalog({ Legal: { [phrase]: 'Leé las {m0o}condiciones{m0c}' } });
        applyRendered(host, renderBlock(blockNodesOf(host), { category: 'Legal', previousCategory: 'Footer' }));
        expect(nested.hasAttribute(PREVIOUS_CATEGORY_MARKER_ATTR)).toBe(false);
    });
});
