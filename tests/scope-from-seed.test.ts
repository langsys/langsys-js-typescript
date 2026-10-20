// @vitest-environment happy-dom
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerBlock, renderBlock, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { t, tSignal } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope, scopeFromSeed } from '../src/request-scope.js';
import { setRequestScopeStorage } from '../src/scope-context.js';
import { _resetSeededBlocks } from '../src/served-source.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';

/**
 * `scopeFromSeed`: the request scope a server rendered, rebuilt on the client from
 * its seed, synchronously, for a hydration render that must read what the server
 * read (React's server snapshot). It sends nothing itself; its misses and blocks go
 * to the page's lanes, which skip what the server collected.
 */

type Item = { type: string; phrase?: string; custom_id?: string };
let sent: Item[] = [];
const settle = () => vi.advanceTimersByTimeAsync(600);
const misses = () => (LangsysApp.Translations as unknown as { missingTokens: Array<{ token: string }> }).missingTokens;
const SERVER_CATALOG = { UI: { Prices: 'Prezzi' } };

function pageCatalog(entries: Record<string, unknown>, locale: string) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set(locale);
}

async function serverSeed(render: () => void = () => {}) {
    const scope = await createRequestScope({ locale: 'it-it', catalog: SERVER_CATALOG as never });
    scope.run(render);
    // What the page carries: the seed, serialised and parsed back.
    return JSON.parse(JSON.stringify(scope.seed()));
}

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    _resetSeededBlocks();
    pageCatalog({ Prices: 'Preise' }, 'de-de');
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
    misses().length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    Object.assign(configStore, { projectid: '', key: '', ssrTokenStrategy: undefined });
});

describe('scopeFromSeed: the server’s scope, on the client, at once', () => {
    it('is synchronous, and renders what the server rendered', async () => {
        const seed = await serverSeed();
        const scope = scopeFromSeed(seed);
        expect(scope).not.toBeInstanceOf(Promise);
        expect(scope.locale).toBe('it-it');
        expect(scope.t('Prices', 'UI')).toBe('Prezzi');
        expect(scope.run(() => t('Prices', 'UI'))).toBe('Prezzi');
        expect(scope.run(() => currentlyLoadedLocale.get())).toBe('it-it');
        // The page is untouched.
        expect(t('Prices', 'UI')).toBe('Preise');
    });

    it('a t taken from tSignal inside run() reads the catalog when called, so a host returns scope.t', async () => {
        const scope = scopeFromSeed(await serverSeed());
        const taken = scope.run(() => tSignal.get());
        expect(scope.run(() => taken('Prices', 'UI'))).toBe('Prezzi');
        expect(taken('Prices', 'UI')).toBe('Preise');
        expect(scope.t('Prices', 'UI')).toBe('Prezzi');
    });

    it('under the client strategy, a miss in its render is recorded on the page and sent', async () => {
        const scope = scopeFromSeed(await serverSeed(() => void t('Unseen line', 'UI')));
        scope.run(() => t('Unseen line', 'UI'));
        await settle();
        expect(sent.filter((i) => i.type === 'phrase').map((i) => i.phrase)).toEqual(['Unseen line']);
    });

    it('a phrase the server collected is not sent again', async () => {
        Object.assign(configStore, { ssrTokenStrategy: 'server' });
        const seed = await serverSeed(() => void t('Server line', 'UI'));
        expect(seed.phrases).toEqual([{ category: 'UI', phrase: 'Server line', collected: true }]);
        scopeFromSeed(seed).run(() => t('Server line', 'UI'));
        await settle();
        expect(sent).toEqual([]);
        expect(misses()).toEqual([]);
    });

    it('a block registered in its render goes to the page’s lane', async () => {
        const tree: BlockNode[] = [{ tag: 'p', children: [{ text: 'Seeded A' }] }, { tag: 'p', children: [{ text: 'Seeded B' }] }];
        const scope = scopeFromSeed(await serverSeed());
        scope.run(() => registerBlock(tree, { category: 'UI' }));
        await settle();
        expect(sent.map((i) => i.custom_id)).toEqual([generateCustomId('UI', ['Seeded A', 'Seeded B'])]);
    });

    it('under an AsyncLocalStorage, a block registered in its render reaches the page’s lane once', async () => {
        const tree: BlockNode[] = [{ tag: 'p', children: [{ text: 'Seeded A' }] }, { tag: 'p', children: [{ text: 'Seeded B' }] }];
        const scope = scopeFromSeed(await serverSeed());
        let queued = 0;
        const queue = globalThis.queueMicrotask;
        // Stops a loop rather than hanging the run: past a thousand, nothing more is queued.
        vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => (++queued < 1000 ? queue(task) : undefined));
        setRequestScopeStorage(new AsyncLocalStorage());
        try {
            scope.run(() => registerBlock(tree, { category: 'UI' }));
            await settle();
        } finally {
            setRequestScopeStorage(null);
        }
        expect(queued).toBeLessThan(1000);
        expect(sent.map((i) => i.custom_id)).toEqual([generateCustomId('UI', ['Seeded A', 'Seeded B'])]);
    });

    it('close() sends nothing: the server’s scope decided', async () => {
        const scope = scopeFromSeed(await serverSeed());
        await expect(scope.close()).resolves.toEqual({ status: true });
        await settle();
        expect(sent).toEqual([]);
    });

    it('its seed carries the blocks the server rendered', async () => {
        const tree: BlockNode[] = [{ tag: 'p', children: [{ text: 'Block A' }] }, { tag: 'p', children: [{ text: 'Block B' }] }];
        const seed = await serverSeed(() => void renderBlock(tree, { category: 'UI' }));
        const id = generateCustomId('UI', ['Block A', 'Block B']);
        expect(Object.keys(scopeFromSeed(seed).seed().blocks)).toEqual([id]);
    });
});

describe('a block rendered with register: false is never registered from its seed (VAR-1, VAR-7)', () => {
    const tree: BlockNode[] = [{ tag: 'p', children: [{ text: 'Goodbye Bo' }] }, { tag: 'p', children: [{ text: 'See you' }] }];
    const id = generateCustomId('UI', ['Goodbye Bo', 'See you']);

    it('the seed marks it, and registerBlock(seededBlock) does nothing', async () => {
        const seed = await serverSeed(() => void renderBlock(tree, { category: 'UI', register: false }));
        expect(seed.blocks[id]).toMatchObject({ tokens: ['Goodbye Bo', 'See you'], register: false });
        expect(seed.blocks[id]).not.toHaveProperty('content');
        registerBlock(seed.blocks[id]);
        await settle();
        expect(sent).toEqual([]);
    });

    it('control: rendered without it, the same seeded block registers', async () => {
        const seed = await serverSeed(() => void renderBlock(tree, { category: 'UI' }));
        expect(seed.blocks[id].register).toBeUndefined();
        registerBlock(seed.blocks[id]);
        await settle();
        expect(sent.map((i) => i.custom_id)).toEqual([id]);
    });
});

describe('a seed registers from the client exactly what a registration over the same nodes sends', () => {
    const p = (text: string): BlockNode => ({ tag: 'p', children: [{ text }] });
    const host = (children: BlockNode[], attrs: Record<string, string | boolean> = {}): BlockNode => ({ tag: 'section', attrs: { 'data-ls-contentblock': true, ...attrs }, children });
    const value = (name: string, text: string): BlockNode => ({ tag: 'p', children: [{ comment: `ls:${name}` }, { text }, { comment: '/ls' }] });

    /** What registering every seed entry sends, and what one registration over the same nodes sends, outside any scope. */
    async function bothPaths(tree: BlockNode[], options: { customId?: string; register?: false } = {}) {
        const seed = await serverSeed(() => void renderBlock(tree, { category: 'UI', ...options }));
        for (const block of Object.values(seed.blocks)) registerBlock(block as never);
        await settle();
        const fromSeed = sent.map((i) => i.custom_id).sort();
        // A fresh page: what the seed path registered is cached as known, and would hold the second path back.
        sent = [];
        _resetSeededBlocks();
        pageCatalog({ Prices: 'Preise' }, 'de-de');
        registerBlock(tree, { category: 'UI', ...options });
        await settle();
        return { seed, fromSeed, fromNodes: sent.map((i) => i.custom_id).sort() };
    }

    it('register: false reaches every nested level: no entry carries content, and none registers; control: without it, all three do', async () => {
        const deep = [p('Outer one'), p('Outer two'), host([p('Mid one'), p('Mid two'), host([p('Your code is 4417-Bo'), p('Inner two')])])];
        const off = await bothPaths(deep, { register: false });
        expect(Object.values(off.seed.blocks).map((b: any) => [b.register, 'content' in b])).toEqual([
            [false, false],
            [false, false],
            [false, false],
        ]);
        expect(off.fromSeed).toEqual([]);
        expect(off.fromNodes).toEqual([]);
        sent = [];
        _resetSeededBlocks();
        pageCatalog({ Prices: 'Preise' }, 'de-de');
        const on = await bothPaths(deep);
        expect(on.fromSeed).toHaveLength(3);
        expect(on.fromSeed).toEqual(on.fromNodes);
    });

    it('an adopted id registers nothing from the seed, while a block nested in it still registers, as over the nodes', async () => {
        const nested = generateCustomId('UI', ['Nested one', 'Nested two']);
        const { seed, fromSeed, fromNodes } = await bothPaths([p('Adopted one'), p('Adopted two'), host([p('Nested one'), p('Nested two')])], { customId: 'adopted-x' });
        expect(seed.blocks['adopted-x']).toMatchObject({ register: false });
        expect(seed.blocks['adopted-x']).not.toHaveProperty('content');
        expect(fromSeed).toEqual([nested]);
        expect(fromNodes).toEqual([nested]);
    });

    it('a block inside a resolved scope and a resolved stamp register nothing from the seed, as over the nodes', async () => {
        const tree = [
            p('Served one'),
            p('Served two'),
            { tag: 'div', attrs: { 'data-ls-resolved': 'it-it' }, children: [host([p('Inside one'), p('Inside two')])] },
            host([p('Stamp one'), p('Stamp two')], { 'data-ls-contentblock': 'stamped-id', 'data-ls-resolved': 'it-it' }),
        ] as BlockNode[];
        const { seed, fromSeed, fromNodes } = await bothPaths(tree);
        expect(seed.blocks['stamped-id']).toMatchObject({ register: false });
        expect(seed.blocks[generateCustomId('UI', ['Inside one', 'Inside two'])]).toMatchObject({ register: false });
        expect(fromSeed).toEqual([generateCustomId('UI', ['Served one', 'Served two'])]);
        expect(fromNodes).toEqual(fromSeed);
    });

    it('a block of value markers only registers nothing from the seed, as over the nodes', async () => {
        const { seed, fromSeed, fromNodes } = await bothPaths([value('total', '42'), value('due', 'Friday')]);
        expect(Object.values(seed.blocks).map((b: any) => [b.register, 'content' in b])).toEqual([[false, false]]);
        expect(fromSeed).toEqual([]);
        expect(fromNodes).toEqual([]);
    });

    it('a nested unit of value markers only registers nothing from the seed, as over the nodes', async () => {
        const { seed, fromSeed, fromNodes } = await bothPaths([p('Total due'), p('By the date'), host([value('total', '42'), value('due', 'Friday')])]);
        expect(Object.values(seed.blocks).filter((b: any) => b.register === false)).toHaveLength(1);
        expect(fromSeed).toEqual([generateCustomId('UI', ['Total due', 'By the date'])]);
        expect(fromNodes).toEqual(fromSeed);
    });

    it('a nested block’s content is its source as written, read before its render fills in a visitor’s params', async () => {
        const tree = [p('Outer one'), p('Outer two'), host([p('Hello {name}'), p('Welcome back')])];
        const seed = await serverSeed(() => void renderBlock(tree, { category: 'UI', params: { name: 'Bo' } }));
        expect(seed.blocks[generateCustomId('UI', ['Hello {name}', 'Welcome back'])].content).toBe('<p>Hello {name}</p><p>Welcome back</p>');
    });

    it('content rides only where a client registers from the seed: not on a phrase-shaped entry, nor on a block the catalog holds', async () => {
        const known = generateCustomId('UI', ['Known one', 'Known two']);
        const unknown = generateCustomId('UI', ['Unknown one', 'Unknown two']);
        const scope = await createRequestScope({ locale: 'it-it', catalog: { UI: { [known]: { 'Known one': 'Noto uno', 'Known two': 'Noto due' } } } as never });
        scope.run(() => {
            renderBlock([p('Lone phrase')], { category: 'UI' });
            renderBlock([p('Known one'), p('Known two')], { category: 'UI' });
            renderBlock([p('Unknown one'), p('Unknown two')], { category: 'UI' });
        });
        const blocks = scope.seed().blocks;
        expect(blocks[generateCustomId('UI', ['Lone phrase'])]).not.toHaveProperty('content');
        expect(blocks[known]).not.toHaveProperty('content');
        expect(blocks[unknown]!.content).toBe('<p>Unknown one</p><p>Unknown two</p>');
    });
});
