// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerBlock, renderBlock, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { t, tSignal } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope, scopeFromSeed } from '../src/request-scope.js';
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
