import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI, LangsysConfigurationError } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { t as topLevelT } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { _sharedCatalogCount, clearSharedCatalogs, createRequestScope } from '../src/request-scope.js';
import { setRequestScopeStorage } from '../src/scope-context.js';
import { createSignal } from '../src/signal.js';
import { config as configStore, currentlyLoadedLocale, writeEnabled } from '../src/stores.js';
import { _resetSsrGrantNotice } from '../src/translations.js';
import seeds, { GRANT_SECRET } from './contract-seeds/request-scope-credentials.js';
import type { World } from './contract-seeds/worlds.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, sleep, until } from './helpers/sdk-session.js';

/**
 * SRV-2, credentials: a server render sends under its request scope's project id and API
 * key, so two scopes in one process never share a credential however they interleave, and
 * a scope given none sends under the module-wide ones.
 *
 * Which key a request went out under is a transport fact, so it is read at the fetch seam,
 * as `never-attempt` reads a request that must not happen. What each scope read and wrote is
 * read back through the API on an SDK test clone (spec CONF-2), which also refuses a key for
 * another project (403), so a mixed pair cannot pass as either tenant. Each case takes a world of
 * its own from tests/contract-seeds/request-scope-credentials.ts, and names its projects and
 * keys by their role there.
 */

let fx: ContractFixture;

let w: World;
const P = (role: string) => w.project(role);
const K = (role: string) => w.key(role);
const ONE = () => ({ projectid: P('one'), key: K('key-one') });
const TWO = () => ({ projectid: P('two'), key: K('key-two') });

/** A write grant the API accepts for `key-two-granted`: an HS256 JWT signed with its secret. */
function grantFor(user: string): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user, exp: Math.floor(Date.now() / 1000) + 300 })}`;
    return `${unsigned}.${createHmac('sha256', GRANT_SECRET).update(unsigned).digest('base64url')}`;
}

interface Sent {
    method: string;
    path: string;
    locale: string | null;
    project: string | null;
    key: string | null;
    grant: string | null;
    body: string;
}

let sent: Sent[] = [];
const realFetch = globalThis.fetch;

/** Every request the SDK sent to the API from here on, with the credentials it carried. */
function recordRequests(): void {
    sent = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.href.startsWith(fx.baseUrl)) {
            const headers = new Headers(init?.headers);
            const body = typeof init?.body === 'string' ? init.body : '';
            const parsed = body ? (JSON.parse(body) as { project_id?: string }) : {};
            const authorize = url.pathname.match(/authorize-project\/([^/]+)$/);
            sent.push({
                method: init?.method ?? 'GET',
                path: url.pathname.slice(new URL(fx.baseUrl).pathname.length),
                locale: url.searchParams.get('locale'),
                project: url.searchParams.get('project_id') ?? parsed.project_id ?? (authorize ? decodeURIComponent(authorize[1]!) : null),
                key: headers.get('x-authorization'),
                grant: headers.get('x-write-grant'),
                body,
            });
        }
        return realFetch(input, init);
    });
}

const READER: Record<string, string> = { zero: 'key-zero', one: 'key-one', two: 'key-two' };
/** The phrases a project holds, by category: an exact set, so a phrase under another category or project shows. */
const phrasesOf = async (project: string) => (await fx.held(K(READER[project]!), P(project), 'de')).phrases;
const keysOf = (requests: Sent[]) => [...new Set(requests.map((r) => r.key))];

async function init(key = 'key-zero', ssrTokenStrategy: 'client' | 'server' | 'auto' = 'server') {
    resetSdk();
    await LangsysApp.init({ projectid: P('zero'), key: K(key), UserLocaleStore: createSignal('en'), baseLocale: 'en', apiUrl: fx.baseUrl, ssrTokenStrategy });
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
    w = seeds.take('tenants');
    await fx.use(w);
    clearSharedCatalogs();
    setRequestScopeStorage(new AsyncLocalStorage());
    await init();
});
afterEach(async () => {
    await LangsysApp.setWriteGrant(undefined);
    setRequestScopeStorage(null);
    vi.restoreAllMocks();
});

/** A render that reads, misses, awaits mid-render, and makes a send of its own from inside the render. */
async function render(locale: string, miss: string, credentials?: { projectid: string; key: string }) {
    const scope = await createRequestScope({ locale, credentials });
    const html = await scope.run(async () => {
        const hello = topLevelT('Hello', 'UI');
        await sleep(10);
        const missed = topLevelT(miss, 'UI');
        await LangsysApp.getCountries(locale);
        return `${hello}|${missed}`;
    });
    return { scope, html, closed: await scope.close() };
}

describe('SRV-2: two scopes in one process never share a credential', () => {
    it('two concurrent renders, each with its own project id and key: every request each made went out under its own key, none under the other’s', async () => {
        recordRequests();
        const [a, b] = await Promise.all([render('de', 'Only in one', ONE()), render('it', 'Only in two', TWO())]);

        expect(a.html).toBe('Hallo one|Only in one');
        expect(b.html).toBe('Ciao two|Only in two');
        expect(a.closed).toEqual({ status: true });
        expect(b.closed).toEqual({ status: true });

        // A render's requests are told apart by what they carry: its locale, or its miss.
        const ofOne = sent.filter((r) => r.locale === 'de' || r.path.endsWith('/de') || r.body.includes('Only in one'));
        const ofTwo = sent.filter((r) => r.locale === 'it' || r.path.endsWith('/it') || r.body.includes('Only in two'));
        expect(ofOne.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /countries/de', 'GET /translations', 'POST /translatable-items']);
        expect(ofTwo.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /countries/it', 'GET /translations', 'POST /translatable-items']);
        expect(keysOf(ofOne)).toEqual([K('key-one')]);
        expect(keysOf(ofTwo)).toEqual([K('key-two')]);
        expect(ofOne.filter((r) => r.project).map((r) => r.project)).toEqual([P('one'), P('one')]);
        expect(ofTwo.filter((r) => r.project).map((r) => r.project)).toEqual([P('two'), P('two')]);
        // Every request is one of the two renders', and none went out under the module's key.
        expect(sent.length).toBe(ofOne.length + ofTwo.length);

        expect(await phrasesOf('one')).toEqual({ UI: ['Hello', 'Only in one'] });
        expect(await phrasesOf('two')).toEqual({ UI: ['Hello', 'Only in two'] });
        expect(await phrasesOf('zero')).toEqual({ UI: ['Hello'] });
    });

    it('a scope given no credentials sends under the module-wide ones, interleaved with one that has its own', async () => {
        recordRequests();
        const [inherited, own] = await Promise.all([render('de', 'Only in zero'), render('it', 'Only in one', ONE())]);

        expect(inherited.html).toBe('Hallo zero|Only in zero');
        expect(own.html).toBe('Ciao one|Only in one');
        const ofZero = sent.filter((r) => r.locale === 'de' || r.path.endsWith('/de') || r.body.includes('Only in zero'));
        expect(ofZero).toHaveLength(3);
        expect(keysOf(ofZero)).toEqual([K('key-zero')]);
        expect(ofZero.filter((r) => r.project).map((r) => r.project)).toEqual([P('zero'), P('zero')]);
        expect(keysOf(sent.filter((r) => !ofZero.includes(r)))).toEqual([K('key-one')]);
        expect(await phrasesOf('zero')).toEqual({ UI: ['Hello', 'Only in zero'] });
        expect(await phrasesOf('one')).toEqual({ UI: ['Hello', 'Only in one'] });
    });

    it('without an ambient storage, a send made inside run() before any await goes under the scope’s key', async () => {
        setRequestScopeStorage(null);
        const scope = await createRequestScope({ locale: 'de', credentials: TWO() });
        recordRequests();
        await scope.run(() => LangsysAppAPI.get('countries/de'));
        await scope.run(() => LangsysAppAPI.get('authorize-project/[projectid]'));
        expect(sent.map((r) => `${r.path} ${r.key}`)).toEqual([`/countries/de ${K('key-two')}`, `/authorize-project/${P('two')} ${K('key-two')}`]);
    });

    it('close() sends under the scope’s own credentials wherever it is called, even inside another scope', async () => {
        const one = await createRequestScope({ locale: 'de', credentials: ONE() });
        const two = await createRequestScope({ locale: 'de', credentials: TWO() });
        const inherited = await createRequestScope({ locale: 'de' });
        one.run(() => topLevelT('Closed inside two', 'UI'));
        inherited.run(() => topLevelT('Closed inside one', 'UI'));
        recordRequests();

        expect(await two.run(() => one.close())).toEqual({ status: true });
        expect(await one.run(() => inherited.close())).toEqual({ status: true });

        expect(sent.map((r) => `${r.key} ${r.project}`)).toEqual([`${K('key-one')} ${P('one')}`, `${K('key-zero')} ${P('zero')}`]);
        expect(await phrasesOf('one')).toEqual({ UI: ['Closed inside two', 'Hello'] });
        expect(await phrasesOf('zero')).toEqual({ UI: ['Closed inside one', 'Hello'] });
        expect(await phrasesOf('two')).toEqual({ UI: ['Hello'] });
    });

    it('a catalog is shared only between scopes with the same credentials', async () => {
        recordRequests();
        const one = await createRequestScope({ locale: 'de', credentials: ONE() });
        const two = await createRequestScope({ locale: 'de', credentials: TWO() });
        const twoAgain = await createRequestScope({ locale: 'de', credentials: TWO() });
        const inherited = await createRequestScope({ locale: 'de' });

        expect([one, two, twoAgain, inherited].map((s) => s.t('Hello', 'UI'))).toEqual(['Hallo one', 'Hallo two', 'Hallo two', 'Hallo zero']);
        expect(sent.map((r) => `${r.path} ${r.key}`)).toEqual([`/translations ${K('key-one')}`, `/translations ${K('key-two')}`, `/translations ${K('key-zero')}`]);
    });

    it('the seed a scope hands the page never carries its key', async () => {
        const { scope } = await render('de', 'Seeded', ONE());
        expect(JSON.stringify(scope.seed())).not.toContain(K('key-one'));
    });
});

describe('SRV-2 with SRV-3: a scope’s write capability is its own key’s', () => {
    it('a read-only key in its own scope pushes nothing, though the process’s key may write; the process key’s scope is the control', async () => {
        recordRequests();
        const readOnly = await render('de', 'From a reader', { projectid: P('two'), key: K('key-two-read') });
        const control = await render('de', 'From the process');

        expect(readOnly.closed).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(sent.filter((r) => r.key === K('key-two-read')).map((r) => r.method)).toEqual(['GET', 'GET']);
        expect(await phrasesOf('two')).toEqual({ UI: ['Hello'] });
        expect(control.closed).toEqual({ status: true });
        expect(await phrasesOf('zero')).toEqual({ UI: ['From the process', 'Hello'] });
    });

    it('two keys for one project never share a catalog, so a reader after a writer still pushes nothing', async () => {
        recordRequests();
        const writer = await render('de', 'From the writer', TWO());
        const reader = await render('de', 'From the reader', { projectid: P('two'), key: K('key-two-read') });

        expect(sent.filter((r) => r.path === '/translations').map((r) => r.key)).toEqual([K('key-two'), K('key-two-read')]);
        expect(writer.closed).toEqual({ status: true });
        expect(reader.closed).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(await phrasesOf('two')).toEqual({ UI: ['From the writer', 'Hello'] });
    });

    it('a scope with a grant and one without, on the same key, never share a write decision', async () => {
        recordRequests();
        const editor = await createRequestScope({ locale: 'de', credentials: { projectid: P('two'), key: K('key-two-granted'), writeGrant: grantFor('editor') } });
        const visitor = await createRequestScope({ locale: 'de', credentials: { projectid: P('two'), key: K('key-two-granted') } });
        visitor.run(() => topLevelT('A visitor’s miss', 'UI'));

        expect(visitor.seed().phrases).toEqual([{ category: 'UI', phrase: 'A visitor’s miss' }]);
        expect(await visitor.close()).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(sent.map((r) => `${r.method} ${r.path} ${r.grant ? 'granted' : 'plain'}`)).toEqual(['GET /translations granted', 'GET /translations plain']);
        void editor;
    });

    it('a scope handed a catalog and credentials of its own has no answer for its key, so close() sends nothing', async () => {
        recordRequests();
        const scope = await createRequestScope({ locale: 'de', catalog: {} as never, credentials: ONE() });
        scope.run(() => topLevelT('Unanswered', 'UI'));
        expect(await scope.close()).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(sent).toEqual([]);
    });

    it('a write key in its own scope pushes under a read-only process, and leaves the process read-only', async () => {
        await init('key-zero-read');
        const before = writeEnabled.get();
        const own = await render('de', 'From a writer', ONE());
        expect(LangsysApp.Translations.mayWrite()).toBe(false);
        expect(writeEnabled.get()).toBe(before);

        // Given a catalog, a scope with no credentials fetches nothing: it decides on the process's capability as the writer's scope left it.
        const inherited = await createRequestScope({ locale: 'de', catalog: {} as never });
        inherited.run(() => topLevelT('From the reader', 'UI'));
        expect(own.closed).toEqual({ status: true });
        expect(await inherited.close()).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
        expect(await phrasesOf('one')).toEqual({ UI: ['From a writer', 'Hello'] });
        expect(await phrasesOf('zero')).toEqual({ UI: ['Hello'] });
    });

    it('a scope’s write grant goes out on its requests, and the process’s grant never goes out under another key', async () => {
        await LangsysApp.setWriteGrant('grant-of-the-process');
        recordRequests();
        const granted = await createRequestScope({ locale: 'de', credentials: { ...ONE(), writeGrant: 'grant-of-one' } });
        const plain = await createRequestScope({ locale: 'it', credentials: TWO() });
        granted.run(() => topLevelT('Granted miss', 'UI'));
        plain.run(() => topLevelT('Plain miss', 'UI'));

        // SSR-2: a grant makes capability per user, so the scope that carries one leaves its misses to the client.
        expect(await granted.close()).toEqual({ status: false, skipped: true, reason: 'client-strategy' });
        // The process's grant is the process's key's: it does not stop a scope with a key of its own.
        expect(await plain.close()).toEqual({ status: true });
        expect(sent.filter((r) => r.key === K('key-one')).map((r) => r.grant)).toEqual(['grant-of-one']);
        expect(sent.filter((r) => r.key === K('key-two')).map((r) => r.grant)).toEqual([null, null]);
        expect(await phrasesOf('two')).toEqual({ UI: ['Hello', 'Plain miss'] });

        // A scope with none of its own sends under the process's key, and so under its grant.
        const inherited = await createRequestScope({ locale: 'de' });
        inherited.run(() => topLevelT('Inherited miss', 'UI'));
        expect(await inherited.close()).toEqual({ status: false, skipped: true, reason: 'client-strategy' });
    });
});

describe('SRV-2: credentials are a project id and a key together', () => {
    it.each([
        ['an empty key', { projectid: 'one', key: '' }],
        ['no project id', { projectid: '', key: 'key-one' }],
        ['a missing key', { projectid: 'one' }],
    ])('%s is refused with LangsysConfigurationError, and nothing is sent', async (_, credentials) => {
        recordRequests();
        await expect(createRequestScope({ locale: 'de', credentials: credentials as never })).rejects.toBeInstanceOf(LangsysConfigurationError);
        expect(sent).toEqual([]);
    });

    it('a process init() gave no credentials serves a scope that has its own, at the host and strategy init() named', async () => {
        // A fresh process: no host and no strategy from an earlier init().
        resetSdk();
        LangsysAppAPI.setBaseUrl('https://unreachable.invalid/api');
        configStore.ssrTokenStrategy = undefined;
        await LangsysApp.init({ UserLocaleStore: createSignal('en'), apiUrl: fx.baseUrl, ssrTokenStrategy: 'server', requireCredentials: true } as never);
        expect(() => topLevelT('Hello', 'UI')).toThrow(LangsysConfigurationError);

        const scope = await createRequestScope({ locale: 'de', credentials: ONE() });
        const block = { category: 'UI', custom_id: 'b'.repeat(32), content: '<p>Block</p>', tokens: ['Block'] } as never;
        const [html, missed, registered] = scope.run(() => [topLevelT('Hello', 'UI'), topLevelT('Missed by one', 'UI'), registerContentBlock(block)] as const);

        expect(html).toBe('Hallo one');
        expect(missed).toBe('Missed by one');
        expect(await registered).toEqual({ status: false, skipped: true, reason: 'deferred' });
        expect(await scope.close()).toEqual({ status: true });
        expect(await phrasesOf('one')).toEqual({ UI: ['Hello', 'Missed by one'] });
    });

    it('through a Proxy, as a reactive store holds it, a scope still sends under its own credentials', async () => {
        const scope = await createRequestScope({ locale: 'de', credentials: ONE() });
        const proxied = new Proxy(scope, {});
        recordRequests();
        await proxied.run(async () => {
            topLevelT('Missed through a proxy', 'UI');
            await LangsysApp.getCountries('de');
        });
        expect(await proxied.close()).toEqual({ status: true });

        expect(sent.map((r) => `${r.method} ${r.path} ${r.key}`)).toEqual([`GET /countries/de ${K('key-one')}`, `POST /translatable-items ${K('key-one')}`]);
        expect(await phrasesOf('one')).toEqual({ UI: ['Hello', 'Missed through a proxy'] });
        expect(await phrasesOf('zero')).toEqual({ UI: ['Hello'] });
    });

    it('the scope object does not carry its key where a serialiser would find it', async () => {
        const scope = await createRequestScope({ locale: 'de', credentials: { ...ONE(), writeGrant: 'grant-of-one' } });
        expect(JSON.stringify(scope)).not.toMatch(/key-one|grant-of-one/);
        expect(Object.values(scope).map((v) => JSON.stringify(v) ?? '').join('')).not.toMatch(/key-one|grant-of-one/);
    });
});

describe('SRV-2: the page’s own lanes stay under the module-wide credentials, wherever they start', () => {
    it('a page catalog fetched from inside a scope goes under the module’s key, and the page’s catalog stays its own', async () => {
        const scope = await createRequestScope({ locale: 'it', credentials: ONE() });
        recordRequests();
        await scope.run(() => LangsysApp.Translations.change('de'));

        expect(sent.map((r) => `${r.path} ${r.key} ${r.project}`)).toEqual([`/translations ${K('key-zero')} ${P('zero')}`]);
        expect(topLevelT('Hello', 'UI')).toBe('Hallo zero');
    });

    it('a page miss recorded inside a scope is sent on the page’s lane, under the module’s key', async () => {
        const scope = await createRequestScope({ locale: 'de', credentials: ONE() });
        recordRequests();
        scope.run(() => LangsysApp.Translations.recordPageMiss('UI', 'A page miss'));
        await until(async () => ((await phrasesOf('zero')).UI ?? []).includes('A page miss'));

        expect(sent.map((r) => `${r.method} ${r.key} ${r.project}`)).toEqual([`POST ${K('key-zero')} ${P('zero')}`]);
        expect(await phrasesOf('one')).toEqual({ UI: ['Hello'] });
    });
});

describe('SRV-2: what the scopes of a long-lived process keep', () => {
    it('a shared catalog past its minute is dropped, not kept for the life of the process', async () => {
        const now = vi.spyOn(Date, 'now');
        const start = Date.now();
        now.mockReturnValue(start);
        await createRequestScope({ locale: 'de', credentials: ONE() });
        await createRequestScope({ locale: 'it', credentials: TWO() });
        expect(_sharedCatalogCount()).toBe(2);

        now.mockReturnValue(start + 61_000);
        await createRequestScope({ locale: 'de', credentials: TWO() });
        expect(_sharedCatalogCount()).toBe(1);
    });

    it('a scope’s own grant leaves its misses to the client, and says so as a module grant does', async () => {
        _resetSsrGrantNotice();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const scope = await createRequestScope({ locale: 'de', credentials: { ...ONE(), writeGrant: grantFor('editor') } });
        scope.run(() => topLevelT('Left to the client', 'UI'));
        expect(await scope.close()).toEqual({ status: false, skipped: true, reason: 'client-strategy' });
        expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/write grant.*degraded to 'client'/s);
    });
});

describe('REG-7: a block’s registration in flight holds back only one under the same credentials', () => {
    const blocksOf = async (project: string) => Object.keys((await fx.held(K(READER[project]!), P(project), 'de')).blocks.UI ?? {});

    it('two scopes closing at once with the same block under different projects’ keys each send it, and each project then holds the block', async () => {
        // The first request is held, so the other scope closes while it is in flight.
        await fx.update(w, { faults: [{ method: 'POST', path: '/translatable-items', times: 1, delay_ms: 2_000 }] });
        const block = { custom_id: 'b-two-scopes', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };
        const scopes = await Promise.all([createRequestScope({ locale: 'de', credentials: ONE() }), createRequestScope({ locale: 'de', credentials: TWO() })]);
        for (const scope of scopes) scope.run(() => void registerContentBlock(block as never));
        recordRequests();
        expect(await Promise.all(scopes.map((scope) => scope.close()))).toEqual([{ status: true }, { status: true }]);
        expect(sent.map((r) => `${r.method} ${r.key} ${r.project}`).sort()).toEqual([`POST ${K('key-one')} ${P('one')}`, `POST ${K('key-two')} ${P('two')}`].sort());
        expect(await blocksOf('one')).toEqual(['b-two-scopes']);
        expect(await blocksOf('two')).toEqual(['b-two-scopes']);
    });
});
