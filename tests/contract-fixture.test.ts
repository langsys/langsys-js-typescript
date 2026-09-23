import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';

/**
 * The contract double's own tests (spec CONF-2). Every other lane grades API-dependent rows
 * against this double, so what it enforces is pinned here: that it can say no, that it holds
 * state, that it computes the write decision rather than being told it, that hints follow the
 * backend's acceptance rules, and that it offers no request log.
 *
 * Each "says no" case is paired with the same request succeeding under the condition that
 * permits it, so a double that refused everything would fail as surely as one that accepted
 * everything.
 */

let fx: ContractFixture;

const BASE_SEED = {
    config: { renderer_egress_ips: ['10.9.9.9'], batch_limit: 3, hint_rate_per_minute: 50 },
    projects: [
        {
            id: 'p1',
            base_locale: 'en-us',
            target_locales: ['es-es'],
            website_url: 'https://www.site.local',
            phrases: [{ category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } }],
        },
        { id: 'p2', target_locales: ['fr-fr'], website_url: 'https://other.local' },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-read', project: 'p1', type: 'read', report_discovered_content: true },
        // The canonical public site: read-only here, permitted to report.
        { key: 'k-public', project: 'p1', type: 'ip_write', report_discovered_content: true },
        { key: 'k-ipw-local', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.0/8'] },
        // May report AND may write from here: the only reason to decline its hint is that
        // the caller can write, which is what isolates that check (GATE-6's server side).
        { key: 'k-writer-reporter', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1'], report_discovered_content: true },
        { key: 'k-grant', project: 'p1', type: 'read', write_grant_secret: 'grant-secret' },
        { key: 'k-other', project: 'p2', type: 'write' },
        { key: 'k-orphan', project: null, type: 'write' },
    ],
};

type Call = { key?: string; grant?: string; method?: string; body?: unknown };
async function api(path: string, call: Call = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (call.key) headers['x-authorization'] = call.key;
    if (call.grant) headers['x-write-grant'] = call.grant;
    const res = await fetch(fx.baseUrl + path, {
        method: call.method ?? (call.body === undefined ? 'GET' : 'POST'),
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const catalog = (key: string, project = 'p1', locale = 'es-es') =>
    api(`/translations?project_id=${project}&locale=${locale}`, { key });
const register = (key: string, items: unknown[], project = 'p1') =>
    api('/translatable-items', { key, body: { project_id: project, translatable_items: items } });
const phrase = (text: string, category: string | null = 'UI') => ({ type: 'phrase', phrase: text, category });
const hint = (key: string | undefined, url: string) => api('/discovery/hint', { key, body: { page_url: url } });

function signGrant(secret: string, claims: Record<string, unknown>): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = part({ alg: 'HS256', typ: 'JWT' });
    const body = part(claims);
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    await fx.stop();
});
beforeEach(async () => {
    await fx.seed(BASE_SEED);
});

describe('it starts the way the README says', () => {
    it('reports an /api base URL on 127.0.0.1', () => {
        expect(fx.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);
    });
});

describe('it can say no, and says yes under the condition that permits it', () => {
    it('no key is 401; an unknown key, or one with no project, is 403; a real key reads', async () => {
        expect((await catalog('')).status).toBe(401);
        expect((await catalog('nope')).status).toBe(403);
        expect((await catalog('k-orphan')).status).toBe(403);
        expect((await catalog('k-read')).status).toBe(200);
    });

    it('a suspended subscription and an exhausted usage balance are 402', async () => {
        await fx.seed({ ...BASE_SEED, projects: [{ ...BASE_SEED.projects[0], subscription_suspended: true }, BASE_SEED.projects[1]] });
        expect((await catalog('k-read')).status).toBe(402);
        await fx.seed({ ...BASE_SEED, keys: [{ key: 'k-broke', project: 'p1', type: 'write', usage_exhausted: true }] });
        expect((await catalog('k-broke')).status).toBe(402);
    });

    it('a session that may not write is refused with 403, and a write key is accepted', async () => {
        expect((await register('k-read', [phrase('New')])).status).toBe(403);
        expect((await register('k-write', [phrase('New')])).status).toBe(200);
    });

    it('authorization runs before the batch check: read-only and over-limit is 403, not 422', async () => {
        const over = [phrase('a'), phrase('b'), phrase('c'), phrase('d')];
        expect((await register('k-read', over)).status).toBe(403);
        expect((await register('k-write', over)).status).toBe(422);
        expect((await register('k-write', over.slice(0, 3))).status).toBe(200);
    });

    it('a key used against another project is 403 on every route, and an unknown project is 404', async () => {
        expect((await api('/authorize-project/p1', { key: 'k-other' })).status).toBe(403);
        expect((await catalog('k-other', 'p1')).status).toBe(403);
        expect((await register('k-other', [phrase('x')], 'p1')).status).toBe(403);
        expect((await api('/authorize-project/p1', { key: 'k-read' })).status).toBe(200);
        expect((await api('/authorize-project/nope', { key: 'k-read' })).status).toBe(404);
    });

    it('advertises the batch limit it enforces', async () => {
        const auth = await api('/authorize-project/p1', { key: 'k-read' });
        expect(auth.body.data.langsys_settings.translatable_items.batch_limit).toBe(3);
    });
});

describe('it holds state: a second read observes the first write', () => {
    it('a registered phrase reads back as present with a null translation', async () => {
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola' });
        await register('k-write', [phrase('Brand new')]);
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola', 'Brand new': null });
    });

    it('a refused write leaves nothing behind', async () => {
        await register('k-read', [phrase('Refused')]);
        expect((await catalog('k-read')).body.data.UI).not.toHaveProperty('Refused');
    });

    it('registration is idempotent', async () => {
        await register('k-write', [phrase('Once')]);
        await register('k-write', [phrase('Once')]);
        const ui = (await fx.state()).projects.p1.phrases.filter((p) => p.phrase === 'Once');
        expect(ui).toHaveLength(1);
    });

    it('input is cleaned as the backend cleans it: trimmed, with empty strings as null', async () => {
        await register('k-write', [phrase('  Padded  '), phrase('No category', '')]);
        const data = (await catalog('k-read')).body.data;
        expect(data.UI).toHaveProperty('Padded');
        expect(data.__uncategorized__).toEqual({ 'No category': null });
    });

    it('skips, never rejects: an empty phrase and the reserved category are dropped with a 200', async () => {
        const res = await register('k-write', [phrase(''), phrase('Reserved', '__uncategorized__'), phrase('Kept')]);
        expect(res.status).toBe(200);
        const all = (await fx.state()).projects.p1.phrases.map((p) => p.phrase);
        expect(all).toContain('Kept');
        expect(all).not.toContain('Reserved');
    });

    it('a categorised block reads back as an object whose phrases are null', async () => {
        await register('k-write', [{ type: 'content_block', custom_id: 'b1', category: 'Home', content: '<p>A</p>', phrases: [{ phrase: 'A' }, { phrase: 'B' }] }]);
        expect((await catalog('k-read')).body.data.Home).toEqual({ b1: { A: null, B: null } });
    });

    it('an uncategorised block registers, and is held in state rather than given an invented catalog key', async () => {
        await register('k-write', [{ type: 'content_block', custom_id: 'b0', category: '', phrases: [{ phrase: 'Loose' }] }]);
        const blocks = (await fx.state()).projects.p1.blocks;
        expect(blocks.map((b) => [b.category, b.custom_id])).toEqual([[null, 'b0']]);
        expect(JSON.stringify((await catalog('k-read')).body.data)).not.toContain('b0');
    });

    it('the regression knob reproduces the backend dropping that block: 200 and nothing stored', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, drop_uncategorized_blocks: true } });
        const res = await register('k-write', [{ type: 'content_block', custom_id: 'b0', category: '', phrases: [{ phrase: 'Loose' }] }]);
        expect(res.status).toBe(200);
        expect((await fx.state()).projects.p1.blocks).toEqual([]);
    });

    it('an empty project answers data as [], not {}', async () => {
        expect((await catalog('k-other', 'p2', 'fr-fr')).body).toMatchObject({ data: [], words: 0, untranslated_words: 0 });
    });
});

describe('write_enabled is computed from key, address and grant', () => {
    const writeEnabled = async (key: string, grant?: string) => (await api('/authorize-project/p1', { key, grant })).body.data.write_enabled;

    it('by key type', async () => {
        expect(await writeEnabled('k-write')).toBe(true);
        expect(await writeEnabled('k-read')).toBe(false);
    });

    it('an ip_write key writes from an allow-listed address and not from another', async () => {
        expect(await writeEnabled('k-ipw-local')).toBe(true);
        expect(await writeEnabled('k-public')).toBe(false);
        expect((await register('k-ipw-local', [phrase('Via IP')])).status).toBe(200);
        expect((await register('k-public', [phrase('Via IP')])).status).toBe(403);
    });

    it('a valid grant makes a read key write-enabled, on authorize, on the catalog envelope and for a write', async () => {
        const grant = signGrant('grant-secret', { sub: 'user-1', exp: nowSeconds() + 300 });
        expect(await writeEnabled('k-grant', grant)).toBe(true);
        expect((await api('/translations?project_id=p1&locale=es-es', { key: 'k-grant', grant })).body.write_enabled).toBe(true);
        expect((await api('/translatable-items', { key: 'k-grant', grant, body: { project_id: 'p1', translatable_items: [phrase('Granted')] } })).status).toBe(200);
    });

    it('an invalid grant does not: wrong secret, no exp, no sub, on a key with no secret', async () => {
        const exp = nowSeconds() + 300;
        expect(await writeEnabled('k-grant', signGrant('wrong', { sub: 'u', exp }))).toBe(false);
        expect(await writeEnabled('k-grant', signGrant('grant-secret', { sub: 'u' }))).toBe(false);
        expect(await writeEnabled('k-grant', signGrant('grant-secret', { exp }))).toBe(false);
        expect(await writeEnabled('k-read', signGrant('grant-secret', { sub: 'u', exp }))).toBe(false);
    });

    it('a grant expires, with 60 seconds of leeway', async () => {
        const grant = signGrant('grant-secret', { sub: 'u', exp: nowSeconds() + 30 });
        expect(await writeEnabled('k-grant', grant)).toBe(true);
        await fx.advanceClock(60);
        expect(await writeEnabled('k-grant', grant), 'inside the leeway').toBe(true);
        await fx.advanceClock(60);
        expect(await writeEnabled('k-grant', grant), 'past it').toBe(false);
    });

    it('a legacy server omits write_enabled and auto_discovery everywhere', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, legacy_omit_capability: true } });
        const auth = (await api('/authorize-project/p1', { key: 'k-write' })).body.data;
        expect(auth).not.toHaveProperty('write_enabled');
        expect(auth).not.toHaveProperty('auto_discovery');
        expect(auth.key_type).toBe('write');
        expect((await catalog('k-write')).body).not.toHaveProperty('write_enabled');
    });

    it('delivers discovery_base_locale_only on both handshakes only when told to', async () => {
        expect((await api('/authorize-project/p1', { key: 'k-read' })).body.data).not.toHaveProperty('discovery_base_locale_only');
        const projects = [{ ...BASE_SEED.projects[0], discovery_base_locale_only: true }, BASE_SEED.projects[1]];
        await fx.seed({ ...BASE_SEED, projects, config: { ...BASE_SEED.config, send_discovery_base_locale_only: true } });
        expect((await api('/authorize-project/p1', { key: 'k-read' })).body.data.discovery_base_locale_only).toBe(true);
        expect((await catalog('k-read')).body.discovery_base_locale_only).toBe(true);
    });
});

describe('hints follow the backend acceptance rules, and only an accepted hint is stored', () => {
    const stored = async () => (await fx.state()).hints;

    it('the canonical public site reports, normalised as the backend normalises', async () => {
        const res = await hint('k-public', 'https://site.local/pricing?utm_source=x&b=2&a=1#features');
        expect(res.status).toBe(204);
        expect(await stored()).toEqual([{ project_id: 'p1', url: 'https://site.local/pricing?a=1&b=2' }]);
    });

    it('answers 204 and stores nothing for an unknown key, a writer, a key not permitted to report, and a foreign host', async () => {
        for (const [key, url] of [
            ['nope', 'https://site.local/a'],
            ['k-write', 'https://site.local/b'],
            ['k-ipw-local', 'https://site.local/c'],
            ['k-grant', 'https://site.local/d'],
            ['k-public', 'https://elsewhere.local/e'],
        ] as const) {
            expect((await hint(key, url)).status, `${key} ${url}`).toBe(204);
        }
        expect(await stored()).toEqual([]);
        // Control: the same session, on its own host, is stored.
        await hint('k-public', 'https://shop.site.local/f');
        expect(await stored()).toHaveLength(1);
    });

    it('a caller that can write is not stored even when it may report; the same key reports once it cannot write', async () => {
        await hint('k-writer-reporter', 'https://site.local/writer');
        expect(await stored()).toEqual([]);
        const keys = BASE_SEED.keys.map((k) => (k.key === 'k-writer-reporter' ? { ...k, ip_allowlist: [] } : k));
        await fx.seed({ ...BASE_SEED, keys });
        await hint('k-writer-reporter', 'https://site.local/writer');
        expect(await stored()).toEqual([{ project_id: 'p1', url: 'https://site.local/writer' }]);
    });

    it('dedups the same key and URL within the TTL, folding #!/ into #/, and accepts again after it', async () => {
        await hint('k-public', 'https://site.local/#!/checkout');
        await hint('k-public', 'https://site.local/#/checkout');
        expect(await stored()).toHaveLength(1);
        await fx.advanceClock(61);
        await hint('k-public', 'https://site.local/#/checkout');
        expect(await stored()).toHaveLength(2);
    });

    it('a project that does not translate new content, or has no credits, stores nothing', async () => {
        const projects = [{ ...BASE_SEED.projects[0], machine_translate_new_phrases: false }, BASE_SEED.projects[1]];
        await fx.seed({ ...BASE_SEED, projects });
        await hint('k-public', 'https://site.local/g');
        await fx.seed({ ...BASE_SEED, projects: [{ ...BASE_SEED.projects[0], credits_exhausted: true }, BASE_SEED.projects[1]] });
        await hint('k-public', 'https://site.local/h');
        expect(await stored()).toEqual([]);
    });

    it('limits per source address with 429, and a rate-limited hint is not stored', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, hint_rate_per_minute: 5 } });
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) statuses.push((await hint('k-public', `https://site.local/p${i}`)).status);
        expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
        expect(await stored()).toHaveLength(5);
    });

    it('rejects a page_url that is not a URL with 422', async () => {
        expect((await hint('k-public', 'not a url')).status).toBe(422);
    });
});

describe('faults are deterministic and consumed in order', () => {
    it('a status fault answers once, then the route behaves normally', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        expect((await register('k-write', [phrase('Retry me')])).status).toBe(500);
        expect((await fx.state()).projects.p1.phrases.map((p) => p.phrase)).not.toContain('Retry me');
        expect((await register('k-write', [phrase('Retry me')])).status).toBe(200);
        expect((await fx.state()).projects.p1.phrases.map((p) => p.phrase)).toContain('Retry me');
    });

    it('a drop fault closes the connection without a response', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'GET', path: '/translations', drop: true }] });
        await expect(catalog('k-read')).rejects.toThrow();
        expect((await catalog('k-read')).status).toBe(200);
    });
});

describe('the duplicate-request guard applies only to keys configured for it', () => {
    it('the fourth identical request inside the window is 429', async () => {
        await fx.seed({ ...BASE_SEED, keys: [...BASE_SEED.keys, { key: 'k-guarded', project: 'p1', type: 'read', duplicate_guard: { max_attempts: 3, window_seconds: 1 } }] });
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await catalog('k-guarded')).status);
        expect(statuses).toEqual([200, 200, 200, 429]);
        const unguarded: number[] = [];
        for (let i = 0; i < 4; i++) unguarded.push((await catalog('k-read')).status);
        expect(unguarded).toEqual([200, 200, 200, 200]);
    });
});

describe('there is no request log', () => {
    it('state carries accepted state only, and no route returns what was received', async () => {
        await register('k-read', [phrase('Refused')]);
        await hint('k-write', 'https://site.local/declined');
        const state = await fx.state();
        expect(Object.keys(state).sort()).toEqual(['hints', 'projects']);
        expect(JSON.stringify(state)).not.toContain('Refused');
        expect(JSON.stringify(state)).not.toContain('declined');
        for (const route of ['/requests', '/log', '/history', '/calls']) {
            expect((await fetch(fx.fixtureUrl + route)).status, route).toBe(404);
        }
    });
});
