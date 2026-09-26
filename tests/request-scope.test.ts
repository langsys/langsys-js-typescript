import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { isContentBlockKnown, registerContentBlock } from '../src/content-block.js';
import { t as topLevelT } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { clearSharedCatalogs, createRequestScope, currentRequestScope } from '../src/request-scope.js';
import { setRequestScopeStorage } from '../src/scope-context.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, sleep, until } from './helpers/sdk-session.js';

/**
 * SRV-7: the core's request scope, graded against the contract double.
 *
 * No `window` here: this is a server process, rendering for many visitors. Each scope has
 * its own locale, catalog view, miss collection (sent only by `close()`, after the response)
 * and hydration seed; a catalog is fetched once and shared read-only; nothing one scope
 * writes reaches another or the page.
 */

let fx: ContractFixture;

const SEED = {
    projects: [
        {
            id: 'p1',
            base_locale: 'en',
            target_locales: ['de', 'it'],
            website_url: 'https://site.local',
            phrases: [
                { category: 'UI', phrase: 'Hello', translations: { de: 'Hallo', it: 'Ciao' } },
                { category: 'UI', phrase: 'Goodbye', translations: { de: 'Tschüss', it: 'Arrivederci' } },
            ],
        },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-read', project: 'p1', type: 'read' },
    ],
};

const GERMAN = ['Hallo', 'Tschüss'];
const registered = async () => (await fx.state()).projects.p1.phrases.map((p) => p.phrase);
const page = (tr: (p: string, c: string) => string) => `<h1>${tr('Hello', 'UI')}</h1><p>${tr('Goodbye', 'UI')}</p>`;

async function init(key = 'k-write', ssrTokenStrategy: 'client' | 'server' | 'auto' = 'server') {
    resetSdk();
    await LangsysApp.init({ projectid: 'p1', key, UserLocaleStore: createSignal('en'), baseLocale: 'en', apiUrl: fx.baseUrl, ssrTokenStrategy });
    // The page's own catalog lands asynchronously; let it, so it cannot move under a test.
    await until(() => currentlyLoadedLocale.get() === 'en');
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
    clearSharedCatalogs();
    setRequestScopeStorage(null);
    await init();
});
afterEach(() => {
    setRequestScopeStorage(null);
    vi.restoreAllMocks();
});

describe('SRV-7: one visitor’s render never carries another’s locale', () => {
    it('de, then it through a new scope, in one process: the second render is Italian, with no German in its bytes', async () => {
        const de = await createRequestScope({ locale: 'de' });
        expect(de.run(() => page(topLevelT as never))).toBe('<h1>Hallo</h1><p>Tschüss</p>');
        const it_ = await createRequestScope({ locale: 'it' });
        const html = it_.run(() => page(topLevelT as never));
        expect(html).toBe('<h1>Ciao</h1><p>Arrivederci</p>');
        for (const word of GERMAN) expect(html).not.toContain(word);
    });

    it('concurrent it and de renders, awaiting mid-render, each carry only their own locale', async () => {
        setRequestScopeStorage(new AsyncLocalStorage());
        const render = async (locale: string, delay: number) => {
            const scope = await createRequestScope({ locale });
            return scope.run(async () => {
                const head = topLevelT('Hello', 'UI' as never);
                await sleep(delay);
                return `${head} ${topLevelT('Goodbye', 'UI' as never)}`;
            });
        };
        const [it_, de] = await Promise.all([render('it', 30), render('de', 5)]);
        expect(it_).toBe('Ciao Arrivederci');
        expect(de).toBe('Hallo Tschüss');
    });

    it('scope.run returns what fn returns, and an async fn’s promise, so a render can be awaited', async () => {
        setRequestScopeStorage(new AsyncLocalStorage());
        const de = await createRequestScope({ locale: 'de' });
        expect(de.run(() => 42)).toBe(42);
        const pending = de.run(async () => {
            await sleep(5);
            return topLevelT('Hello', 'UI' as never);
        });
        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).resolves.toBe('Hallo');
    });

    it('scope.enter() makes the scope current for the rest of the async context, for hosts that cannot wrap the render', async () => {
        setRequestScopeStorage(new AsyncLocalStorage());
        const [it_, de] = await Promise.all([createRequestScope({ locale: 'it' }), createRequestScope({ locale: 'de' })]);
        // Two requests, each entering its scope before rendering, interleaved at an await.
        const request = async (scope: typeof it_, delay: number) => {
            scope.enter();
            await sleep(delay);
            return `${topLevelT('Hello', 'UI' as never)} ${LangsysApp.t('Goodbye', 'UI')}`;
        };
        const [itHtml, deHtml] = await Promise.all([request(it_, 20), request(de, 5)]);
        expect(itHtml).toBe('Ciao Arrivederci');
        expect(deHtml).toBe('Hallo Tschüss');
    });

    it('scope.enter() without a storage that can enter says what to do instead', async () => {
        const de = await createRequestScope({ locale: 'de' });
        expect(() => de.enter()).toThrow(/setRequestScopeStorage|scope\.run/);
    });

    it('scope.t works without any ambient storage, across await', async () => {
        const [it_, de] = await Promise.all([createRequestScope({ locale: 'it' }), createRequestScope({ locale: 'de' })]);
        await sleep(5);
        expect([page(it_.t as never), page(de.t as never)]).toEqual(['<h1>Ciao</h1><p>Arrivederci</p>', '<h1>Hallo</h1><p>Tschüss</p>']);
    });

    it('inside a scope, the lookups Translate and Phrase make read the scope’s catalog', async () => {
        const de = await createRequestScope({ locale: 'de', catalog: { UI: { Hello: 'Hallo', b1: { One: 'Eins' } } } as never });
        de.run(() => {
            expect(LangsysApp.Translations.lookup('Hello', 'UI')).toBe('Hallo');
            expect(LangsysApp.Translations.lookupContent('UI', 'b1', 'One')).toBe('Eins');
            expect(isContentBlockKnown('UI', 'b1')).toBe(true);
        });
        expect(LangsysApp.Translations.lookup('Hello', 'UI'), 'control: the page catalog holds no German').toBeNull();
        expect(isContentBlockKnown('UI', 'b1')).toBe(false);
    });

    it('outside every scope, t() is the page’s again, and the page’s catalog was never touched', async () => {
        const before = JSON.stringify(sTranslations.get());
        const de = await createRequestScope({ locale: 'de' });
        de.run(() => page(topLevelT as never));
        expect(currentRequestScope()).toBeUndefined();
        expect(de.run(() => currentRequestScope())).toBe(de);
        expect(JSON.stringify(sTranslations.get())).toBe(before);
    });
});

describe('SRV-7: a catalog is fetched at most once, and shared read-only', () => {
    it('two scopes on one locale share one fetch; another locale fetches its own', async () => {
        const fetches = vi.spyOn(LangsysAppAPI, 'getTranslations');
        await Promise.all([createRequestScope({ locale: 'de' }), createRequestScope({ locale: 'de' })]);
        expect(fetches).toHaveBeenCalledTimes(1);
        await createRequestScope({ locale: 'it' });
        expect(fetches).toHaveBeenCalledTimes(2);
    });

    it('the shared catalog is frozen, and a seed is the client’s own copy', async () => {
        const a = await createRequestScope({ locale: 'de' });
        const b = await createRequestScope({ locale: 'de' });
        const seed = a.seed();
        seed.catalog.UI!.Hello = 'Mutated';
        expect(b.t('Hello', 'UI' as never)).toBe('Hallo');
        // The shared catalog itself refuses a write (strict-mode modules throw on a frozen object).
        const shared = (a as unknown as { catalog: Record<string, Record<string, string>> }).catalog;
        expect(() => {
            shared.UI!.Hello = 'x';
        }).toThrow();
    });

    it('a catalog passed in is used as given, with no fetch', async () => {
        const fetches = vi.spyOn(LangsysAppAPI, 'getTranslations');
        const scope = await createRequestScope({ locale: 'de', catalog: { UI: { Hello: 'Servus' } } as never });
        expect(scope.t('Hello', 'UI' as never)).toBe('Servus');
        expect(fetches).not.toHaveBeenCalled();
    });

    it('the seed hydrates the client: seedCatalog(seed.catalog, seed.locale) renders what the server rendered', async () => {
        const de = await createRequestScope({ locale: 'de' });
        const seed = JSON.parse(JSON.stringify(de.seed()));
        LangsysApp.seedCatalog(seed.catalog, seed.locale);
        expect(LangsysApp.t('Hello', 'UI')).toBe('Hallo');
    });

    it('a failed fetch renders source text, records nothing, and is not shared', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', times: 1, status: 500 }] });
        const down = await createRequestScope({ locale: 'de' });
        expect(down.t('Hello', 'UI' as never)).toBe('Hello');
        down.t('Only while down', 'UI' as never);
        expect(down.misses()).toEqual([]);
        const next = await createRequestScope({ locale: 'de' });
        expect(next.t('Hello', 'UI' as never)).toBe('Hallo');
    });
});

describe('SRV-7 with SRV-3: misses are the scope’s own, and sent only by close(), after the response', () => {
    it('each scope records only its own misses, and the page records none', async () => {
        const de = await createRequestScope({ locale: 'de' });
        const it_ = await createRequestScope({ locale: 'it' });
        de.t('Only in de', 'UI' as never);
        it_.t('Only in it', 'UI' as never);
        expect(de.misses()).toEqual([{ category: 'UI', phrase: 'Only in de' }]);
        expect(it_.misses()).toEqual([{ category: 'UI', phrase: 'Only in it' }]);
        expect((LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens).toEqual([]);
    });

    it('nothing is sent during the render; close() sends it, and the double holds it', async () => {
        const de = await createRequestScope({ locale: 'de' });
        de.run(() => topLevelT('New on the server', 'UI' as never));
        await sleep(600);
        expect(await registered()).not.toContain('New on the server');
        await expect(de.close()).resolves.toEqual({ status: true });
        expect(await registered()).toContain('New on the server');
        await expect(de.close(), 'a second close resolves the first result').resolves.toEqual({ status: true });
    });

    it('a content block found inside a scope is deferred to close()', async () => {
        const de = await createRequestScope({ locale: 'de' });
        const block = { custom_id: 'b-scope', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['Block A', 'Block B'] };
        await expect(de.run(() => registerContentBlock(block as never))).resolves.toEqual({ status: false, skipped: true, reason: 'deferred' });
        expect((await fx.state()).projects.p1.blocks.map((b) => b.custom_id)).not.toContain('b-scope');
        await de.close();
        expect((await fx.state()).projects.p1.blocks.map((b) => b.custom_id)).toContain('b-scope');
    });

    it('a read-only key sends nothing on close; the write key on the same render is the control', async () => {
        await init('k-read');
        const read = await createRequestScope({ locale: 'de' });
        read.run(() => topLevelT('Same render', 'UI' as never));
        await expect(read.close()).resolves.toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(await registered()).not.toContain('Same render');

        await init('k-write');
        clearSharedCatalogs();
        const write = await createRequestScope({ locale: 'de' });
        write.run(() => topLevelT('Same render', 'UI' as never));
        await expect(write.close()).resolves.toEqual({ status: true });
        expect(await registered()).toContain('Same render');
    });

    it('under the client strategy (SSR-1) close() leaves the misses to the client', async () => {
        await init('k-write', 'client');
        const de = await createRequestScope({ locale: 'de' });
        de.t('Left to the client', 'UI' as never);
        await expect(de.close()).resolves.toEqual({ status: false, skipped: true, reason: 'client-strategy' });
        expect(await registered()).not.toContain('Left to the client');
    });
});
