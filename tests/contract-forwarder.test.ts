import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFile, type World } from './contract-seeds/worlds.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { standInCheckout, standInClone, useStandIns } from './helpers/stand-in-clone.js';

/**
 * The contract fixture's forwarder (`contract-fixture/forwarder.mjs`), against a stand-in for an
 * SDK test clone and for langsys's hint reader. The stand-in clone records what reaches it, which
 * is the forwarder's whole job: each request sent from its case's own address, a case's faults and
 * crafted reference lists applied to that case's requests only, and a request that names no case
 * refused. The forwarder is started through the test helper, by `LANGSYS_CONTRACT_TARGET` and
 * `LANGSYS_CONTRACT_CLONE_ROOT`, as the suite starts it. What the crafted lists hold is
 * `contract-reference-lists`'s.
 *
 * Each behaviour is paired with what it leaves alone, so a forwarder that rewrote everything
 * fails as surely as one that rewrote nothing.
 */

const stub = standInClone();
const checkout = standInCheckout();
let fx: ContractFixture;

const seeds = seedFile('forwarder', 20, {
    case: {
        projects: { p1: { target_locales: ['es-es'] }, p2: { target_locales: ['fr-fr'] } },
        keys: { 'k-write': { project: 'p1', type: 'write' }, 'k-other': { project: 'p2', type: 'write' } },
        count: 80,
    },
    content: {
        projects: {
            p1: {
                base_locale: 'en',
                target_locales: ['es-es'],
                website_url: 'https://site.local',
                phrases: [
                    { category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } },
                    { phrase: 'Acme', translatable: false },
                    // A translation at the base locale, which the catalog does not serve in place of the phrase.
                    { category: 'UI', phrase: 'Bye', translations: { en: 'Goodbye' } },
                ],
                blocks: [{ category: 'Home', custom_id: 'b1', content: '<p>Welcome</p>', phrases: [{ phrase: 'Welcome', translations: { es_ES: 'Bienvenido' } }] }],
            },
            p2: { target_locales: ['fr-fr'], subscription_suspended: true, phrases: [{ phrase: 'Unpaid' }] },
        },
        keys: {
            'k-write': { project: 'p1', type: 'write' },
            'k-ipw': { project: 'p1', type: 'ip_write', ip_allowlist: ['@self'] },
            'k-grant': { project: 'p1', type: 'read', write_grant_secret: 'grant-secret-of-at-least-32-bytes' },
            'k-unpaid': { project: 'p2', type: 'read' },
            'k-orphan': { project: null, type: 'write' },
        },
        count: 16,
    },
});

/** The stand-in clone holds the seed with one change, as if a seed had not landed as declared. */
function holdChanged(change: (doc: { projects: Record<string, any>[]; keys: Record<string, any>[] }) => void) {
    const doc = structuredClone(seeds.document) as { projects: Record<string, any>[]; keys: Record<string, any>[] };
    change(doc);
    stub.seed(doc);
}
const projectIn = (doc: { projects: Record<string, any>[] }, id: string) => doc.projects.find((p) => p.id === id)!;
const keyIn = (doc: { keys: Record<string, any>[] }, id: string) => doc.keys.find((k) => k.id === id)!;
let a: World;
let b: World;

async function call(path: string, opts: { key?: string; token?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
    if (opts.key) headers['x-authorization'] = opts.key;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(fx.baseUrl + path, { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers, body: opts.body });
    const text = await res.text();
    let body: any = text;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // Kept as text.
    }
    return { status: res.status, headers: res.headers, body };
}
const setup = (body: unknown) => fetch(fx.fixtureUrl + '/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lastApi = () => stub.api.at(-1)!;
const catalogOf = (world: World) => `/translations?project_id=${world.project()}&locale=es-es`;

beforeAll(async () => {
    await stub.listen();
    useStandIns(stub, checkout);
    fx = await startContractFixture();
});

afterAll(async () => {
    await fx?.stop();
    await stub.close();
});

beforeEach(async () => {
    stub.clear();
    stub.seed(seeds.document);
    a = seeds.take('case');
    b = seeds.take('case');
    await fx.use(a);
    await fx.use(b);
});

describe('a request reaches the clone from its case’s own address', () => {
    it('X-Forwarded-For is the case’s address, set by the forwarder over whatever the request carried', async () => {
        await call(catalogOf(a), { key: a.key('k-write'), headers: { 'x-forwarded-for': '203.0.113.9' } });
        expect(lastApi().headers['x-forwarded-for']).toBe(a.address);
        await call(catalogOf(b), { key: b.key('k-write') });
        expect(lastApi().headers['x-forwarded-for']).toBe(b.address);
    });

    it('a request names its case by its key, its user token, or the project in the path, the query or a JSON body', async () => {
        await call(catalogOf(a), { key: b.key('k-write') });
        expect(lastApi().headers['x-forwarded-for'], 'the key wins over the project').toBe(b.address);
        await call('/api-keys/x', { method: 'PATCH', token: a.user().token, body: '{}' });
        expect(lastApi().headers['x-forwarded-for']).toBe(a.address);
        await call(`/authorize-project/${b.project()}`);
        expect(lastApi().headers['x-forwarded-for']).toBe(b.address);
        await call(`/translations?project_id=${a.project('p2')}&locale=fr-fr`, { key: 'not-a-case-key' });
        expect(lastApi().headers['x-forwarded-for']).toBe(a.address);
        await call('/translatable-items', { body: JSON.stringify({ project_id: b.project(), translatable_items: [] }) });
        expect(lastApi().headers['x-forwarded-for']).toBe(b.address);
    });

    it('a request that names no case is refused with 421 and its route, and nothing reaches the clone; control: with the case’s key it is forwarded', async () => {
        const refused = await call('/discovery/hint', { key: 'not-a-case-key', body: JSON.stringify({ page_url: 'https://site.local/' }) });
        expect(refused.status).toBe(421);
        expect(refused.body).toMatchObject({ ok: false, fixture: 'no_case', route: 'POST /api/discovery/hint' });
        expect(stub.api).toEqual([]);
        const forwarded = await call('/discovery/hint', { key: a.key('k-write'), body: JSON.stringify({ page_url: 'https://site.local/' }) });
        expect(forwarded.status).toBe(200);
        expect(stub.api).toHaveLength(1);
    });

    it('ids, keys and bodies reach the clone as the test sent them', async () => {
        const body = JSON.stringify({ project_id: a.project(), translatable_items: [{ type: 'phrase', phrase: 'Hello' }] });
        await call('/translatable-items', { key: a.key('k-write'), body });
        expect(lastApi().path).toBe('/api/translatable-items');
        expect(lastApi().body).toBe(body);
        expect(lastApi().headers['x-authorization']).toBe(a.key('k-write'));
        await call(`/authorize-project/${a.project()}`, { key: a.key('k-write') });
        expect(lastApi().path).toBe(`/api/authorize-project/${a.project()}`);
        await call('/translatable-items', { key: a.key('k-write'), body: 'project_id=x&not json' });
        expect(lastApi().body).toBe('project_id=x&not json');
        expect(lastApi().headers).not.toHaveProperty('x-sdk-fixture');
    });

    it('a setup naming a case again updates it: a move changes its address and keeps its faults', async () => {
        await fx.update(a, { faults: [{ method: 'GET', path: '/translations', status: 503, times: 2 }] });
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(503);
        await fx.update(a, { caller: a.moved });
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status, 'the fault stayed').toBe(503);
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(200);
        expect(lastApi().headers['x-forwarded-for']).toBe(a.moved);
        await call(catalogOf(b), { key: b.key('k-write') });
        expect(lastApi().headers['x-forwarded-for'], 'the other case did not move').toBe(b.address);
    });

    it('a setup is refused with 400 when it names no case, carries an undeclared field, gives a caller that is not an address, names two cases, or starts a case with no caller; control: a valid one is taken', async () => {
        const fresh = seeds.take('case');
        for (const [why, body] of [
            ['no names', { caller: '10.75.40.200' }],
            ['an undeclared field', { keys: fresh.keys, caller: fresh.address, config: { batch_limit: 3 } }],
            ['a caller that is not an address', { keys: fresh.keys, caller: 'localhost' }],
            ['two cases', { keys: [a.key('k-write'), b.key('k-write')] }],
            ['a new case with no caller', { keys: fresh.keys }],
        ] as const) {
            expect((await setup(body)).status, why).toBe(400);
        }
        expect((await setup({ keys: fresh.keys, projects: fresh.projects, tokens: fresh.tokens, caller: fresh.address })).status).toBe(200);
    });
});

describe('a case confirms its seed landed before it acts, as the project’s owner reads it', () => {
    let w: World;
    beforeEach(() => {
        w = seeds.take('content');
        stub.clear();
    });

    it('control: a seed the clone holds is named; its owner read each project’s keys, the catalog at each locale, the rows and the block, from the case’s address', async () => {
        await fx.use(w);
        const reads = stub.owner.map((r) => `${r.path}${r.search.size ? `?${r.search}` : ''}`);
        const p1 = w.project('p1');
        const p2 = w.project('p2');
        expect(reads.sort()).toEqual(
            [
                `/api/api-keys?project_id=${p1}`,
                `/api/api-keys?project_id=${p2}`,
                // A suspended project's own read is not made: its catalog's 402 is its seed.
                `/api/projects/${p1}`,
                `/api/translatable-items/stand-in-block-b1`,
                `/api/translatable-items/stand-in-phrase-Bye`,
                `/api/translations/data?project_id=${p1}&locale=en`,
                `/api/translations?project_id=${p1}&locale=en`,
                `/api/translations?project_id=${p1}&locale=es-es`,
                // A suspended project's catalog is read once: it answers 402, and no route reads its content.
                `/api/translations?project_id=${p2}&locale=en-us`,
            ].sort()
        );
        for (const r of stub.owner) {
            expect(r.headers['x-forwarded-for']).toBe(w.address);
            expect(r.headers.authorization).toBe(`Bearer ${w.user(r.search.get('project_id') === p2 ? 'p2' : 'p1').token}`);
            expect(r.headers['x-langsys-capabilities']).toBe('icu');
            expect(r.headers['x-authorization'], 'no key of the case’s is used').toBeUndefined();
        }
        expect(stub.api).toEqual([]);
    });

    it('a key the clone does not hold fails the case as a seed not landed', async () => {
        holdChanged((doc) => (doc.keys = doc.keys.filter((k) => k.id !== w.keyId('k-write'))));
        await expect(fx.use(w)).rejects.toThrow(new RegExp(`^seed not landed: ${w.name} key k-write \\(${w.keyId('k-write')}\\) is not listed$`));
    });

    it('a key held with another type, allow-list or grant fails it, each named', async () => {
        holdChanged((doc) => {
            keyIn(doc, w.keyId('k-write')).type = 'read';
            keyIn(doc, w.keyId('k-ipw')).ip_allowlist = [w.moved];
            delete keyIn(doc, w.keyId('k-grant')).write_grant_secret;
        });
        const failed = await fx.use(w).catch((e: Error) => e.message);
        expect(failed).toMatch(new RegExp(`^seed not landed: ${w.name} `));
        expect(failed).toContain('key k-write is {"type":"read",');
        expect(failed).toContain(`key k-ipw is {"type":"ip_write","ip_allowlist":["${w.moved}"],`);
        expect(failed).toContain(`seeded {"type":"ip_write","ip_allowlist":["${w.address}"],`);
        expect(failed).toContain('key k-grant is {"type":"read","ip_allowlist":null,"active":true,"write_grant_secret":false}');
    });

    it('a translation, a phrase or an untranslatable flag the catalog does not serve fails it, each named with its locale', async () => {
        holdChanged((doc) => {
            const p1 = projectIn(doc, w.project('p1'));
            p1.phrases[0].translations = {};
            p1.phrases[1].translatable = true;
            p1.blocks[0].phrases[0].translations = { 'es-es': 'Hola a todos' };
        });
        const failed = await fx.use(w).catch((e: Error) => e.message);
        expect(failed).toContain('p1: "Hello" in UI is served at es-es as null, seeded "Hola"');
        expect(failed).toContain('p1: "Acme" in __uncategorized__ is served at en as "Acme", seeded null');
        expect(failed).toContain('p1: "Welcome" in block b1 is served at es-es as "Hola a todos", seeded "Bienvenido"');
        holdChanged((doc) => (projectIn(doc, w.project('p1')).phrases = []));
        const missing = await fx.use(w).catch((e: Error) => e.message);
        expect(missing).toContain('p1: "Hello" in UI is not served at en');
        expect(missing).toContain('p1: "Hello" in UI is not served at es-es');
    });

    it('a translation seeded at the base locale is read as the item’s own, since the catalog serves the phrase there', async () => {
        holdChanged((doc) => (projectIn(doc, w.project('p1')).phrases[2].translations = { en: 'See you' }));
        await expect(fx.use(w)).rejects.toThrow(`seed not landed: ${w.name} p1: "Bye" in UI holds "See you" at en, seeded "Goodbye"`);
        holdChanged((doc) => (projectIn(doc, w.project('p1')).phrases[2].translations = {}));
        await expect(fx.use(w)).rejects.toThrow(`seed not landed: ${w.name} p1: "Bye" in UI holds null at en, seeded "Goodbye"`);
    });

    it('a block the catalog does not serve, or one holding other markup, fails it', async () => {
        holdChanged((doc) => (projectIn(doc, w.project('p1')).blocks[0].content = '<p>Welcome!</p>'));
        await expect(fx.use(w)).rejects.toThrow(`seed not landed: ${w.name} p1: block b1 holds "<p>Welcome!</p>", seeded "<p>Welcome</p>"`);
        holdChanged((doc) => (projectIn(doc, w.project('p1')).blocks = []));
        const failed = await fx.use(w).catch((e: Error) => e.message);
        expect(failed).toContain('p1: block b1 is not served at en');
        expect(failed).toContain('p1: block b1 has no row');
    });

    it('a world a run has written to fails it: a phrase, a block or a block’s phrase its seed does not declare', async () => {
        holdChanged((doc) => {
            const p1 = projectIn(doc, w.project('p1'));
            p1.phrases.push({ category: 'UI', phrase: 'Registered by a run' });
            p1.blocks.push({ category: 'Home', custom_id: 'b9', content: '<p>Nine</p>', phrases: [{ phrase: 'Nine' }] });
            p1.blocks[0].phrases.push({ phrase: 'Grown' });
        });
        await expect(fx.use(w)).rejects.toThrow(
            `seed not landed: ${w.name} p1 holds "Registered by a run" in UI, "Grown" in block b1, block b9 in Home, which its seed does not: a run has used this world, so reseed the clone`
        );
        // A world that seeds no content is read too.
        const empty = seeds.take('case');
        holdChanged((doc) => (projectIn(doc, empty.project('p2')).phrases = [{ phrase: 'Registered by a run' }]));
        await expect(fx.use(empty)).rejects.toThrow(`seed not landed: ${empty.name} p2 holds "Registered by a run" in __uncategorized__, which its seed does not`);
    });

    it('a hint stored for its projects fails it too; control: with none stored it is named', async () => {
        checkout.setHints([{ project_id: w.project('p2'), url: 'https://site.local/' }]);
        await expect(fx.use(w)).rejects.toThrow(`seed not landed: ${w.name} the clone holds 1 hint(s) for its projects, which its seed does not: a run has used this world, so reseed the clone`);
        checkout.setHints([]);
        await fx.use(w);
    });

    it('a project whose settings are not its seed’s fails it, each setting named', async () => {
        holdChanged((doc) => {
            const p1 = projectIn(doc, w.project('p1'));
            p1.website_url = 'https://other.local';
            p1.target_locales = ['es-es', 'fr-fr'];
            p1.machine_translate_new_phrases = true;
        });
        await expect(fx.use(w)).rejects.toThrow(
            `seed not landed: ${w.name} p1's settings are {"website_url":"https://other.local","base_locale":"en","target_locales":["es-es","fr-fr"],"discovery_base_locale_only":false,"machine_translate_new_phrases":true}, ` +
                `seeded {"website_url":"https://site.local","base_locale":"en","target_locales":["es-es"],"discovery_base_locale_only":false,"machine_translate_new_phrases":false}`
        );
    });

    it('a project seeded suspended whose catalog answers is not its seed', async () => {
        holdChanged((doc) => (projectIn(doc, w.project('p2')).subscription_suspended = false));
        await expect(fx.use(w)).rejects.toThrow(`seed not landed: ${w.name} p2 is not suspended: its catalog answered 200`);
    });

    it('the case’s faults are set once its seed is confirmed, so the check spends none of them', async () => {
        await fx.use(w, { faults: [{ method: 'GET', path: '/translations', status: 503 }] });
        const catalog = `/translations?project_id=${w.project('p1')}&locale=es-es`;
        expect((await call(catalog, { key: w.key('k-write') })).status, 'the case’s first catalog read is faulted').toBe(503);
        expect((await call(catalog, { key: w.key('k-write') })).status).toBe(200);
    });
});

describe('the clone’s answers are relayed', () => {
    it('the status, the headers and an empty answer', async () => {
        stub.answer = (_r, res) => {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
            res.end(JSON.stringify({ status: false, error: { code: 'too_many_requests' } }));
        };
        const limited = await call('/discovery/hint', { key: a.key('k-write'), body: '{}' });
        expect([limited.status, limited.headers.get('retry-after'), limited.body.error.code]).toEqual([429, '7', 'too_many_requests']);
        stub.answer = (_r, res) => {
            res.writeHead(204);
            res.end();
        };
        const accepted = await call('/discovery/hint', { key: a.key('k-write'), body: '{}' });
        expect([accepted.status, accepted.body]).toEqual([204, null]);
    });

    it('a connection the clone drops is dropped; control: the next request is answered', async () => {
        stub.answer = (_r, res) => res.socket?.destroy();
        await expect(fetch(fx.baseUrl + catalogOf(a), { headers: { 'x-authorization': a.key('k-write') } })).rejects.toThrow();
        stub.answer = null;
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(200);
    });
});

describe('a case’s faults apply in the forwarder, before the clone, to that case only', () => {
    it('a fault answers in the clone’s place as many times as it says, as the API renders it, then the clone answers', async () => {
        await fx.update(a, { faults: [{ method: 'GET', path: '/translations', status: 503, times: 2 }] });
        for (let i = 0; i < 2; i++) {
            const faulted = await call(catalogOf(a), { key: a.key('k-write') });
            expect([faulted.status, faulted.body]).toEqual([503, { status: false, error: { message: 'Service unavailable.', code: 'service_unavailable', template: 'Service unavailable.' } }]);
        }
        expect(stub.api).toEqual([]);
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(200);
        expect(stub.api).toHaveLength(1);
    });

    it('another case’s request on the same route reaches the clone', async () => {
        await fx.update(a, { faults: [{ method: 'GET', path: '/translations', status: 503 }] });
        expect((await call(catalogOf(b), { key: b.key('k-write') })).status).toBe(200);
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(503);
    });

    it('a fault applies to its method only: the same path by another method reaches the clone', async () => {
        await fx.update(a, { faults: [{ method: 'POST', path: '/translations', status: 503 }] });
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(200);
        expect(stub.api).toHaveLength(1);
        expect((await call('/translations', { key: a.key('k-write'), body: '{}' })).status).toBe(503);
        expect(stub.api).toHaveLength(1);
    });

    it('a delay holds the request that long, and then the clone answers it', async () => {
        await fx.update(a, { faults: [{ method: 'GET', path: '/translations', delay_ms: 400 }] });
        const started = Date.now();
        expect((await call(catalogOf(a), { key: a.key('k-write') })).status).toBe(200);
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        expect(stub.api).toHaveLength(1);
    });

    it('a raw body answers as sent, and a drop closes the connection; neither reaches the clone, and another route is not faulted', async () => {
        await fx.update(a, {
            faults: [
                { method: 'GET', path: '/translations', status: 502, body: '<html>Bad gateway</html>', content_type: 'text/html' },
                { method: 'POST', path: '/translatable-items', drop: true },
            ],
        });
        const page = await call(catalogOf(a), { key: a.key('k-write') });
        expect([page.status, page.headers.get('content-type'), page.body]).toEqual([502, 'text/html', '<html>Bad gateway</html>']);
        await expect(fetch(fx.baseUrl + '/translatable-items', { method: 'POST', headers: { 'x-authorization': a.key('k-write') }, body: '{}' })).rejects.toThrow();
        expect(stub.api).toEqual([]);
        expect((await call(`/authorize-project/${a.project()}`, { key: a.key('k-write') })).status).toBe(200);
    });
});

describe('a case’s crafted reference lists answer the reference routes the clone accepts', () => {
    const lists = (countries: string[]) => ({ countries: countries.map((code) => ({ code })), locales: [], dial_codes: [], currencies: [] });
    const codes = (res: { body: { data: Array<{ code: string }> } }) => res.body.data.map((row) => row.code);

    it('each case’s own lists, named in the display locale; a case without lists gets the clone’s table', async () => {
        await fx.update(a, { reference: lists(['ES']) });
        await fx.update(b, { reference: lists(['IT', 'FR']) });
        expect(codes(await call('/countries/es-es', { key: a.key('k-write') }))).toEqual(['ES']);
        expect(codes(await call('/countries/es-es', { key: b.key('k-write') }))).toEqual(['FR', 'IT']);
        expect((await call('/countries/es-es', { key: a.key('k-write') })).body.data[0].label).toBe('España');
        expect(stub.api.map((r) => r.path), 'the clone answered each request first').toEqual(['/api/countries/es-es', '/api/countries/es-es', '/api/countries/es-es']);
        const c = seeds.take('case');
        await fx.use(c);
        expect(codes(await call('/countries/es-es', { key: c.key('k-write') }))).toEqual(['CLONE']);
    });

    it('a request the clone refuses is refused as the clone refuses it, and another route is the clone’s', async () => {
        await fx.update(a, { reference: lists(['ES']) });
        stub.answer = (_r, res) => {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: false, error: { code: 'api_key_invalid' } }));
        };
        const refused = await call('/countries/es-es', { key: a.key('k-write') });
        expect([refused.status, refused.body.error.code]).toEqual([403, 'api_key_invalid']);
        stub.answer = null;
        expect((await call(catalogOf(a), { key: a.key('k-write') })).body.data.path).toBe('/api/translations');
    });

    it('a case’s lists change with its setup', async () => {
        await fx.update(a, { reference: lists(['ES']) });
        expect(codes(await call('/countries/es-es', { key: a.key('k-write') }))).toEqual(['ES']);
        await fx.update(a, { reference: lists(['CR']) });
        expect(codes(await call('/countries/es-es', { key: a.key('k-write') }))).toEqual(['CR']);
    });
});

describe('state is the hints langsys’s reader prints for the case’s projects', () => {
    it('only the projects named, in the reader’s order; a project named by none answers none', async () => {
        checkout.setHints([
            { project_id: a.project(), url: 'https://site.local/a' },
            { project_id: b.project(), url: 'https://site.local/b' },
            { project_id: a.project('p2'), url: 'https://site.local/a2' },
        ]);
        expect(await fx.hints(a)).toEqual([
            { project_id: a.project(), url: 'https://site.local/a' },
            { project_id: a.project('p2'), url: 'https://site.local/a2' },
        ]);
        expect(await fx.hints(b)).toEqual([{ project_id: b.project(), url: 'https://site.local/b' }]);
        expect(await fx.hints(seeds.take('case'))).toEqual([]);
    });

    it('the fixture’s routes are setup, state and clock: there is no request log, and no seed or reset', async () => {
        for (const [method, route] of [
            ['GET', '/requests'],
            ['GET', '/log'],
            ['GET', '/history'],
            ['GET', '/calls'],
            ['POST', '/seed'],
            ['POST', '/reset'],
            ['GET', '/setup'],
        ] as const) {
            expect((await fetch(fx.fixtureUrl + route, { method, body: method === 'POST' ? '{}' : undefined })).status, `${method} ${route}`).toBe(404);
        }
        expect((await fetch(`${fx.fixtureUrl}/state?project=${a.project()}`)).status).toBe(200);
    });

    it('a read naming no project is 400, and a reader that refuses is 502 with its reason', async () => {
        expect((await fetch(`${fx.fixtureUrl}/state`)).status).toBe(400);
        const refused = await fetch(`${fx.fixtureUrl}/state?project=not-a-uuid`);
        expect(refused.status).toBe(502);
        expect((await refused.json()).error).toContain('not a UUID');
    });
});

describe('the clock, starting and stopping', () => {
    it('advancing the clock waits that long in real time; a negative advance is refused', async () => {
        const started = Date.now();
        await fx.advanceClock(1);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
        const res = await fetch(fx.fixtureUrl + '/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advance_seconds: -1 }) });
        expect(res.status).toBe(400);
    });

    it('with no clone named the fixture refuses to start, naming what to set, so a contract test never passes by skipping; control: with both named it starts', async () => {
        for (const variable of ['LANGSYS_CONTRACT_TARGET', 'LANGSYS_CONTRACT_CLONE_ROOT']) {
            const value = process.env[variable];
            delete process.env[variable];
            try {
                await expect(startContractFixture(), variable).rejects.toThrow(/LANGSYS_CONTRACT_TARGET.*LANGSYS_CONTRACT_CLONE_ROOT/);
            } finally {
                process.env[variable] = value;
            }
        }
        const started = await startContractFixture();
        expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);
        await started.stop();
    });

    it('LANGSYS_CONTRACT_LOG logs its start, each setup and each refused request; once stopped it answers nothing', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'forwarder-log-')), 'forwarder.jsonl');
        process.env.LANGSYS_CONTRACT_LOG = log;
        const other = await startContractFixture();
        delete process.env.LANGSYS_CONTRACT_LOG;
        const c = seeds.take('case');
        await other.use(c);
        expect((await fetch(`${other.baseUrl}/translations?project_id=nobody&locale=es-es`)).status).toBe(421);
        expect((await fetch(`${other.baseUrl}${catalogOf(c)}`, { headers: { 'x-authorization': c.key('k-write') } })).status).toBe(200);
        const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        // A fetch client sends a request answered 421 once more on a new connection, as the Fetch
        // standard says, so the refusal is logged each time; the forwarded request is not logged.
        expect(events.slice(0, 2).map((e) => e.event)).toEqual(['started', 'setup']);
        expect(events.slice(2).length).toBeGreaterThan(0);
        expect(events.slice(2).every((e) => e.event === 'no_case' && e.route === 'GET /api/translations')).toBe(true);
        await other.stop();
        await expect(fetch(`${other.baseUrl}${catalogOf(c)}`, { headers: { 'x-authorization': c.key('k-write') } })).rejects.toThrow();
    });

    it('a checkout whose reader fails or is missing, or a target that is not a Langsys API, is refused at start; control: the stand-ins are taken', async () => {
        const site = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html>a site</html>');
        });
        await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
        const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
        const failing = mkdtempSync(join(tmpdir(), 'clone-root-'));
        mkdirSync(join(failing, 'tests', 'Sdk'), { recursive: true });
        writeFileSync(join(failing, 'tests', 'Sdk', 'accepted-hints.php'), '<?php fwrite(STDERR, "not an SDK test clone\\n"); exit(1);\n');
        const run = (target: string, root: string) =>
            new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
                const child = spawn(process.execPath, [join(process.cwd(), 'contract-fixture', 'forwarder.mjs'), '--target', target, '--clone-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (c) => {
                    stdout += c;
                    if (stdout.includes('\n')) child.kill('SIGTERM');
                });
                child.stderr.on('data', (c) => (stderr += c));
                child.once('exit', (code) => resolve({ code, stdout, stderr }));
            });
        try {
            for (const [target, root, said] of [
                [stub.url, failing, 'is not an SDK test clone'],
                [stub.url, mkdtempSync(join(tmpdir(), 'not-a-checkout-')), 'is not an SDK test clone'],
                [siteUrl, checkout.root, 'does not answer as a Langsys API'],
            ] as const) {
                const refused = await run(target, root);
                expect(refused.code, `${target} ${root}`).toBe(2);
                expect(refused.stdout).toBe('');
                expect(refused.stderr).toContain(said);
            }
            const taken = await run(stub.url, checkout.root);
            expect(JSON.parse(taken.stdout.split('\n')[0]!)).toMatchObject({ ready: true });
        } finally {
            await new Promise<void>((resolve) => site.close(() => resolve()));
        }
    });
});
