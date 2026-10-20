import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';

/**
 * The contract double's forwarding mode (`contract-fixture/forwarder.mjs`), against a stand-in
 * for an SDK test clone. The stand-in answers the clone's fixture routes and records what reaches
 * it, which is the forwarder's whole job: a seed and its requests translated for a clone that holds
 * many fixtures and takes only ids nothing has used, and its answers translated back. The
 * forwarder is started through the test helper, by `LANGSYS_CONTRACT_TARGET`, as the suite starts it.
 *
 * Each translation is paired with what it leaves alone, so a forwarder that rewrote everything
 * fails as surely as one that rewrote nothing.
 */

type Received = { method: string; path: string; search: URLSearchParams; headers: IncomingHttpHeaders; body: string };
type Seeded = { fixture: string; doc: any };

/** An SDK test clone's fixture routes, recorded; its API answers with what it saw unless a test says otherwise. */
function standIn() {
    const fixtures = new Map<string, any>();
    const stub = {
        url: '',
        seeds: [] as Seeded[],
        resets: [] as string[],
        events: [] as string[],
        api: [] as Received[],
        refuseNextSeed: false,
        answer: null as null | ((r: Received, res: ServerResponse) => void),
        server: null as unknown as Server,
        clear() {
            this.seeds = [];
            this.resets = [];
            this.events = [];
            this.api = [];
            this.refuseNextSeed = false;
            this.answer = null;
        },
    };
    const json = (res: ServerResponse, status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
    };
    const stateOf = (doc: any) => ({
        projects: Object.fromEntries(
            (doc.projects ?? []).map((p: any) => [
                p.id,
                {
                    human_translation_words_used: 0,
                    phrases: (p.phrases ?? []).map((ph: any) => ({ category: ph.category ?? null, phrase: ph.phrase, translatable: true, translations: ph.translations ?? {} })),
                    blocks: (p.blocks ?? []).map((b: any) => ({ category: b.category ?? null, custom_id: b.custom_id, content: b.content, label: null, phrases: b.phrases ?? [] })),
                },
            ])
        ),
        hints: (doc.projects ?? []).slice(0, 1).map((p: any) => ({ project_id: p.id, url: 'https://site.local/' })),
    });
    stub.server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://stand-in.local');
            const body = Buffer.concat(chunks).toString('utf8');
            if (url.pathname === '/__fixture/seed') {
                // As the clone does: a field its seed does not declare is refused, and nothing is created.
                const undeclared = Object.keys(JSON.parse(body || '{}')).filter((field) => !['config', 'projects', 'keys'].includes(field));
                if (undeclared.length) {
                    const errors = undeclared.map((field) => ({ field, code: 'not_allowed', message: 'This field is not allowed.', template: 'This field is not allowed.' }));
                    return json(res, 422, { status: false, error: { message: 'The request failed validation.', code: 'validation_failed', template: 'The request failed validation.', errors } });
                }
                if (stub.refuseNextSeed) {
                    stub.refuseNextSeed = false;
                    stub.events.push('seed refused');
                    return json(res, 422, { status: false, error: { message: 'The request failed validation.', code: 'validation_failed', template: 'The request failed validation.', errors: [] } });
                }
                const fixture = randomUUID();
                const doc = JSON.parse(body);
                fixtures.set(fixture, doc);
                stub.seeds.push({ fixture, doc });
                stub.events.push(`seed ${fixture}`);
                return json(res, 200, { status: true, data: { fixture } });
            }
            if (url.pathname === '/__fixture/reset') {
                const { fixture } = JSON.parse(body);
                stub.resets.push(fixture);
                stub.events.push(`reset ${fixture}`);
                fixtures.delete(fixture);
                return json(res, 200, { status: true });
            }
            if (url.pathname === '/__fixture/state') {
                const doc = fixtures.get(url.searchParams.get('fixture') ?? '');
                return doc ? json(res, 200, { status: true, data: stateOf(doc) }) : json(res, 404, { status: false, error: { code: 'not_found' } });
            }
            const received = { method: req.method ?? 'GET', path: url.pathname, search: url.searchParams, headers: req.headers, body };
            stub.api.push(received);
            if (stub.answer) return stub.answer(received, res);
            let sent: any = null;
            try {
                sent = JSON.parse(body);
            } catch {
                // A body that is not JSON is echoed as received.
            }
            json(res, 200, {
                status: true,
                data: { path: url.pathname, project_id: url.searchParams.get('project_id') ?? sent?.project_id ?? null, key: req.headers['x-authorization'] ?? null },
            });
        });
    });
    return stub;
}

const stub = standIn();
let fx: ContractFixture;

const SEED = {
    config: { batch_limit: 3, renderer_egress_ips: ['127.0.0.1', '10.9.9.9'] },
    projects: [
        {
            id: 'p1',
            base_locale: 'en-us',
            target_locales: ['es-es'],
            phrases: [{ category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } }],
            blocks: [
                { category: 'UI', custom_id: 'b-bare', phrases: [{ phrase: 'Bare' }] },
                { category: 'UI', custom_id: 'b-kept', content: '<p>Kept</p>', phrases: [{ phrase: 'Kept' }] },
            ],
        },
        { id: 'p2', target_locales: ['fr-fr'], machine_translate_new_phrases: false },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-local', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1', '10.0.0.0/8'] },
        { key: 'k-orphan', project: null, type: 'write' },
    ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function call(path: string, opts: { key?: string; method?: string; body?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.key) headers['x-authorization'] = opts.key;
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

const lastSeed = () => stub.seeds.at(-1)!;
const lastApi = () => stub.api.at(-1)!;

beforeAll(async () => {
    await new Promise<void>((resolve) => stub.server.listen(0, '127.0.0.1', resolve));
    const address = stub.server.address() as { port: number };
    stub.url = `http://127.0.0.1:${address.port}`;
    process.env.LANGSYS_CONTRACT_TARGET = stub.url;
    delete process.env.LANGSYS_CONTRACT_LOG;
    fx = await startContractFixture();
});

afterAll(async () => {
    await fx?.stop();
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
});

beforeEach(async () => {
    stub.clear();
    await fx.seed(SEED);
});

describe('a seed reaches the clone translated', () => {
    it('project ids and keys are fresh for each seed, and a key names its project by the fresh id', async () => {
        const first = lastSeed().doc;
        expect(first.projects.map((p: any) => p.id)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)]);
        expect(first.keys.map((k: any) => k.key)).toEqual([expect.stringMatching(/^sdkfx_[0-9a-f]{40}$/), expect.stringMatching(/^sdkfx_[0-9a-f]{40}$/), expect.stringMatching(/^sdkfx_[0-9a-f]{40}$/)]);
        expect(first.keys.map((k: any) => k.project)).toEqual([first.projects[0].id, first.projects[0].id, null]);
        await fx.seed(SEED);
        const second = lastSeed().doc;
        expect(second.projects[0].id).not.toBe(first.projects[0].id);
        expect(second.keys[0].key).not.toBe(first.keys[0].key);
    });

    it('machine translation reaches the clone as the seed gives it: left out where it is left out, and as given where it says', () => {
        expect(lastSeed().doc.projects.map((p: any) => 'machine_translate_new_phrases' in p)).toEqual([false, true]);
        expect(lastSeed().doc.projects[1].machine_translate_new_phrases).toBe(false);
    });

    it('the seed’s loopback entries name the seed’s own address, every request comes from it, and other entries stay', async () => {
        const doc = lastSeed().doc;
        const own = doc.keys[1].ip_allowlist[0];
        expect(own).toMatch(/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        expect(own).not.toBe('127.0.0.1');
        expect(doc.keys[1].ip_allowlist).toEqual([own, '10.0.0.0/8']);
        expect(doc.config.renderer_egress_ips).toEqual([own, '10.9.9.9']);
        expect(doc.keys[0]).not.toHaveProperty('ip_allowlist');
        await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(lastApi().headers['x-forwarded-for']).toBe(own);
    });

    it('faults never reach the clone; the rest of config does', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', status: 503 }] });
        const doc = lastSeed().doc;
        expect(doc).not.toHaveProperty('faults');
        expect(doc.config).toEqual({ batch_limit: 3, renderer_egress_ips: [expect.any(String), '10.9.9.9'] });
    });

    it('a block with no content goes with a placeholder, which state reads back as null; a block with content keeps it', async () => {
        const blocks = lastSeed().doc.projects[0].blocks;
        expect(blocks[0].content).toEqual(expect.any(String));
        expect(blocks[0].content).not.toBe('');
        expect(blocks[1].content).toBe('<p>Kept</p>');
        expect((await fx.state()).projects.p1.blocks.map((b) => b.content)).toEqual([null, '<p>Kept</p>']);
    });
});

describe('a seed replaces the one before it', () => {
    it('the new fixture is created before the earlier one is reset', async () => {
        const earlier = lastSeed().fixture;
        stub.clear();
        await fx.seed(SEED);
        expect(stub.events).toEqual([`seed ${lastSeed().fixture}`, `reset ${earlier}`]);
    });

    it('a seed the clone refuses answers 400, and the earlier fixture stays in place', async () => {
        const earlier = lastSeed();
        stub.clear();
        stub.refuseNextSeed = true;
        const res = await fetch(fx.fixtureUrl + '/seed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SEED) });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false });
        expect(stub.events).toEqual(['seed refused']);
        await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(lastApi().headers['x-sdk-fixture']).toBe(earlier.fixture);
        expect(lastApi().headers['x-authorization']).toBe(earlier.doc.keys[0].key);
    });

    it('a reset after a seed the double holds leaves nothing held either: a request after it goes to the clone and names no fixture', async () => {
        await fx.seed({ ...SEED, reference: { locales: ['es-es'] } });
        stub.clear();
        await fx.reset();
        expect(await fx.state()).toEqual({ projects: {}, hints: [] });
        await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(stub.api).toHaveLength(1);
        expect(lastApi().headers).not.toHaveProperty('x-sdk-fixture');
    });

    it('a reset resets the fixture, state is empty, and a request after it names no fixture', async () => {
        const { fixture, doc } = lastSeed();
        stub.clear();
        await fx.reset();
        expect(stub.resets).toEqual([fixture]);
        expect(await fx.state()).toEqual({ projects: {}, hints: [] });
        await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(lastApi().headers).not.toHaveProperty('x-sdk-fixture');
        expect(lastApi().headers['x-authorization']).not.toBe(doc.keys[0].key);
    });
});

describe('requests carry the fixture’s ids, and answers and state the test’s', () => {
    it('a project id in the path, the query and the body is the fixture’s on the way in and the test’s on the way out, and so is the key', async () => {
        const doc = lastSeed().doc;
        const p1 = doc.projects[0].id;
        const authorize = await call('/authorize-project/p1', { key: 'k-write' });
        expect(lastApi().path).toBe(`/api/authorize-project/${p1}`);
        expect(lastApi().headers['x-authorization']).toBe(doc.keys[0].key);
        expect(authorize.body.data).toEqual({ path: '/api/authorize-project/p1', project_id: null, key: 'k-write' });

        const catalog = await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(lastApi().search.get('project_id')).toBe(p1);
        expect(lastApi().search.get('locale')).toBe('es-es');
        expect(catalog.body.data).toMatchObject({ project_id: 'p1', key: 'k-write' });

        const register = await call('/translatable-items', { key: 'k-write', body: JSON.stringify({ project_id: 'p1', translatable_items: [{ type: 'phrase', phrase: 'p1' }] }) });
        expect(JSON.parse(lastApi().body)).toEqual({ project_id: p1, translatable_items: [{ type: 'phrase', phrase: 'p1' }] });
        expect(register.body.data).toMatchObject({ project_id: 'p1' });
    });

    it('a project id and a key the seed never named are mapped too, the same way each time', async () => {
        await call('/translations?project_id=p-unknown&locale=es-es', { key: 'nope' });
        const first = lastApi();
        await call('/translations?project_id=p-unknown&locale=es-es', { key: 'nope' });
        expect(first.search.get('project_id')).toMatch(UUID);
        expect(lastApi().search.get('project_id')).toBe(first.search.get('project_id'));
        expect(first.headers['x-authorization']).not.toBe('nope');
        expect(lastApi().headers['x-authorization']).toBe(first.headers['x-authorization']);
    });

    it('a request with no key goes with none, and names its fixture', async () => {
        await call('/discovery/hint', { body: JSON.stringify({ page_url: 'https://site.local/a' }) });
        expect(lastApi().headers).not.toHaveProperty('x-authorization');
        expect(lastApi().headers['x-sdk-fixture']).toBe(lastSeed().fixture);
    });

    it('a body that is not JSON goes as it came', async () => {
        await call('/translatable-items', { key: 'k-write', body: 'project_id=p1&not json' });
        expect(lastApi().body).toBe('project_id=p1&not json');
    });

    it('state reads back under the test’s ids', async () => {
        const state = await fx.state();
        expect(Object.keys(state.projects)).toEqual(['p1', 'p2']);
        expect(state.projects.p1.phrases).toEqual([{ category: 'UI', phrase: 'Hello', translatable: true, translations: { 'es-es': 'Hola' } }]);
        expect(state.hints).toEqual([{ project_id: 'p1', url: 'https://site.local/' }]);
    });

    it('the status, the headers and an empty answer are relayed', async () => {
        stub.answer = (_r, res) => {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
            res.end(JSON.stringify({ status: false, error: { code: 'too_many_requests' } }));
        };
        const limited = await call('/discovery/hint', { key: 'k-write', body: '{}' });
        expect([limited.status, limited.headers.get('retry-after'), limited.body.error.code]).toEqual([429, '7', 'too_many_requests']);
        stub.answer = (_r, res) => {
            res.writeHead(204);
            res.end();
        };
        const accepted = await call('/discovery/hint', { key: 'k-write', body: '{}' });
        expect([accepted.status, accepted.body]).toEqual([204, null]);
    });

    it('a connection the clone drops is dropped; control: the next request is answered', async () => {
        stub.answer = (_r, res) => res.socket?.destroy();
        await expect(fetch(fx.baseUrl + '/translations?project_id=p1&locale=es-es')).rejects.toThrow();
        stub.answer = null;
        expect((await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' })).status).toBe(200);
    });
});

describe('faults apply in the forwarder, before the clone', () => {
    it('a fault answers in the clone’s place as many times as it says, as the double renders it, then the clone answers', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', status: 503, times: 2 }] });
        stub.api = [];
        for (let i = 0; i < 2; i++) {
            const faulted = await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
            expect([faulted.status, faulted.body]).toEqual([503, { status: false, error: { message: 'Service unavailable.', code: 'service_unavailable', template: 'Service unavailable.' } }]);
        }
        expect(stub.api).toEqual([]);
        expect((await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' })).status).toBe(200);
        expect(stub.api).toHaveLength(1);
    });

    it('a fault applies to its method only: the same path by another method reaches the clone', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'POST', path: '/translations', status: 503 }] });
        stub.api = [];
        expect((await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' })).status).toBe(200);
        expect(stub.api).toHaveLength(1);
        expect((await call('/translations', { key: 'k-write', body: '{}' })).status).toBe(503);
        expect(stub.api).toHaveLength(1);
    });

    it('a delay holds the request that long, and then the clone answers it', async () => {
        await fx.seed({ ...SEED, faults: [{ method: 'GET', path: '/translations', delay_ms: 400 }] });
        stub.api = [];
        const started = Date.now();
        expect((await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' })).status).toBe(200);
        expect(Date.now() - started).toBeGreaterThanOrEqual(400);
        expect(stub.api).toHaveLength(1);
    });

    it('a raw body answers as sent, and a drop closes the connection; neither reaches the clone, and another route is not faulted', async () => {
        await fx.seed({
            ...SEED,
            faults: [
                { method: 'GET', path: '/translations', status: 502, body: '<html>Bad gateway</html>', content_type: 'text/html' },
                { method: 'POST', path: '/translatable-items', drop: true },
            ],
        });
        stub.api = [];
        const page = await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect([page.status, page.headers.get('content-type'), page.body]).toEqual([502, 'text/html', '<html>Bad gateway</html>']);
        await expect(fetch(fx.baseUrl + '/translatable-items', { method: 'POST', body: '{}' })).rejects.toThrow();
        expect(stub.api).toEqual([]);
        expect((await call('/authorize-project/p1', { key: 'k-write' })).status).toBe(200);
    });
});

describe('a seed a clone cannot take stays on the in-process double', () => {
    it('reference tables: the double holds the seed and answers the API, the clone sees neither and its fixture is reset; the next seed goes back to the clone', async () => {
        const earlier = lastSeed().fixture;
        stub.clear();
        await fx.seed({ ...SEED, reference: { locales: ['es-es'] } });
        expect(stub.seeds).toEqual([]);
        expect(stub.resets).toEqual([earlier]);
        const catalog = await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(catalog.body.data.UI.Hello).toBe('Hola');
        expect((await fx.state()).projects.p1.blocks.map((b) => b.content)).toEqual([null, '<p>Kept</p>']);
        expect(stub.api).toEqual([]);
        await fx.seed(SEED);
        expect(stub.seeds).toHaveLength(1);
        await call('/translations?project_id=p1&locale=es-es', { key: 'k-write' });
        expect(stub.api).toHaveLength(1);
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

    it('stopping resets the fixture it holds and stops the in-process double; control: the double answers until then', async () => {
        const log = join(mkdtempSync(join(tmpdir(), 'forwarder-log-')), 'forwarder.jsonl');
        process.env.LANGSYS_CONTRACT_LOG = log;
        const other = await startContractFixture();
        delete process.env.LANGSYS_CONTRACT_LOG;
        const started = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((e) => e.event === 'started');
        expect((await fetch(`${started.double}/__fixture/state`)).status).toBe(200);
        await other.seed(SEED);
        const { fixture } = lastSeed();
        await other.stop();
        expect(stub.resets).toContain(fixture);
        // It is signalled as the forwarder exits; give it a moment to close.
        let down = false;
        for (let i = 0; i < 40 && !down; i++) {
            down = await fetch(`${started.double}/__fixture/state`).then(
                () => false,
                () => true
            );
            if (!down) await new Promise((r) => setTimeout(r, 50));
        }
        expect(down).toBe(true);
    });

    it('a target that is not an SDK test clone is refused at start, a Langsys that is not one included; control: the stand-in is taken', async () => {
        // A Langsys instance that is not a clone answers every /__fixture path as a missing route.
        const missing = JSON.stringify({ status: false, error: { message: 'Resource not found', code: 'not_found', template: 'Resource not found' } });
        const site = createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html>a site</html>');
        });
        const langsys = createServer((_req, res) => {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(missing);
        });
        const listen = async (server: Server) => {
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        };
        const run = (target: string) =>
            new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
                const child = spawn(process.execPath, [join(process.cwd(), 'contract-fixture', 'forwarder.mjs'), '--target', target], { stdio: ['ignore', 'pipe', 'pipe'] });
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
            for (const target of [await listen(site), await listen(langsys)]) {
                const refused = await run(target);
                expect(refused.code, target).toBe(2);
                expect(refused.stdout).toBe('');
                expect(refused.stderr).toContain('is not an SDK test clone');
            }
            const taken = await run(stub.url);
            expect(JSON.parse(taken.stdout.split('\n')[0]!)).toMatchObject({ ready: true });
        } finally {
            for (const server of [site, langsys]) await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
