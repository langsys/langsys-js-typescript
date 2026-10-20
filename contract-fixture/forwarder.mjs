#!/usr/bin/env node
/**
 * The contract double's forwarding mode: the same two namespaces as `server.mjs`, with the
 * API answered by a real Langsys instance, an SDK test clone (langsys docs/sdk-test-clone.md).
 * `/api` goes to the clone's API, and the setup namespace to its `/__fixture` routes.
 *
 * Usage: `node forwarder.mjs --target https://api.langsys5.test [--port N] [--log FILE]`.
 * Prints the same ready line as `server.mjs`. A clone served over HTTPS by a local CA needs
 * that CA in NODE_EXTRA_CA_CERTS. `--log` appends one JSON line per seed: where it went, and
 * why when it stayed on the in-process double or the clone refused it.
 *
 * A seed means what it means on the double. The clone holds many fixtures and the double
 * one state, so the forwarder translates:
 * - A seed creates a new fixture and then resets the one before it, so it replaces state; a
 *   refused seed leaves the earlier one in place, as on the double.
 * - Each seed's project ids and keys are mapped to fresh ones, a UUID and a random key, since
 *   a clone takes only ids nothing has used. Every project id or key a request names is mapped,
 *   seeded or not, and answers and state are mapped back.
 * - Each seed calls from a loopback address of its own, sent as X-Forwarded-For, which a
 *   clone trusts from loopback; the seed's `127.0.0.1` entries name that address. The hint
 *   limiter counts per address, so its count starts at zero with each seed, as on the double.
 * - Every request names its fixture in X-Sdk-Fixture, so one whose key names no fixture (no
 *   key, an unknown key, a key with no project) runs with the seed's config, as on the double.
 * - `machine_translate_new_phrases` takes the double's default, true, where a seed leaves it
 *   out.
 * - A seeded block with no `content` is stored with a placeholder, since the backend holds
 *   none without one, and state reads it back as null.
 * - Faults are applied here, before forwarding. A connection the clone or the double drops
 *   is dropped here too.
 * - A clone has no clock: advancing it waits that long in real time.
 * - A seed the clone cannot take (reference tables, or the behaviour of an older server) is
 *   served by the in-process double, started alongside.
 *
 * Node built-ins only.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const option = (name) => {
    const at = process.argv.indexOf(name);
    return at > -1 ? process.argv[at + 1] : undefined;
};
const target = (option('--target') ?? '').replace(/\/+$/, '');
if (!target) {
    process.stderr.write('forwarder: --target is required\n');
    process.exit(2);
}
const logFile = option('--log');
const log = (entry) => logFile && appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------
// Answers the forwarder gives itself, as server.mjs renders them
// ---------------------------------------------------------------------------------------

const apiError = (code, message) => ({ status: false, error: { message, code, template: message } });
/** ApiErrorService::forStatus, for a fault with a bare status. */
const STATUS_ERRORS = {
    400: ['bad_request', 'Bad request.'],
    401: ['unauthenticated', 'Unauthenticated.'],
    402: ['payment_required', 'Payment required.'],
    403: ['forbidden', 'Forbidden.'],
    404: ['not_found', 'Resource not found'],
    405: ['method_not_allowed', 'The requested method is not allowed for this route.'],
    409: ['conflict', 'Conflict.'],
    410: ['gone', 'Gone.'],
    422: ['unprocessable_entity', 'Unprocessable entity.'],
    429: ['too_many_requests', 'Too many requests. Please try again later.'],
    500: ['internal_error', 'Internal server error.'],
    502: ['external_service_error', 'External service error.'],
    503: ['service_unavailable', 'Service unavailable.'],
};
const statusError = (status) => apiError(...(STATUS_ERRORS[status] ?? STATUS_ERRORS[500]));

function send(res, status, body) {
    if (status === 204 || body === null) {
        res.writeHead(status);
        return res.end();
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

// ---------------------------------------------------------------------------------------
// The in-process double, for the seeds a clone cannot take
// ---------------------------------------------------------------------------------------

async function startDouble() {
    const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const ready = await new Promise((resolve, reject) => {
        let buffered = '';
        child.stdout.on('data', (chunk) => {
            buffered += chunk.toString('utf8');
            const newline = buffered.indexOf('\n');
            if (newline > -1) resolve(JSON.parse(buffered.slice(0, newline)));
        });
        child.once('exit', (code) => reject(new Error(`the in-process double exited with code ${code}`)));
    });
    return { child, origin: new URL(ready.base_url).origin };
}

/** What the clone refuses and the double models: a seed carrying any of these stays on the double. */
function doubleOnly(doc) {
    const reasons = [];
    if (doc.reference !== undefined) reasons.push('reference');
    if (doc.config?.legacy_omit_capability) reasons.push('config.legacy_omit_capability');
    if (doc.config?.drop_uncategorized_blocks) reasons.push('config.drop_uncategorized_blocks');
    return reasons;
}

// ---------------------------------------------------------------------------------------
// A fixture: where its requests go, and its ids both ways
// ---------------------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const NO_CONTENT = 'sdk-fixture:no-content';

function context(mode) {
    const octet = () => 1 + Math.floor(Math.random() * 254);
    return {
        mode, // 'clone' | 'double'
        fixture: null,
        projects: new Map(),
        keys: new Map(),
        address: `127.${octet()}.${octet()}.${octet()}`,
        faults: [],
    };
}

const mapped = (table, value, fresh) => {
    if (!table.has(value)) table.set(value, fresh());
    return table.get(value);
};
const mapProject = (ctx, id) => (typeof id === 'string' && id !== '' ? mapped(ctx.projects, id, randomUUID) : id);
const mapKey = (ctx, key) => (typeof key === 'string' && key.trim() !== '' ? mapped(ctx.keys, key.trim(), () => `sdkfx_${randomBytes(20).toString('hex')}`) : key);

/** The clone's ids in a text, written back as the test named them. */
function unmap(ctx, text) {
    for (const table of [ctx.projects, ctx.keys]) {
        for (const [original, fresh] of table) text = text.split(fresh).join(JSON.stringify(original).slice(1, -1));
    }
    return text;
}

function translateSeed(ctx, doc) {
    const out = structuredClone(doc);
    const caller = (list) => (Array.isArray(list) ? list.map((entry) => (LOOPBACK.has(entry) ? ctx.address : entry)) : list);
    if (out.config && typeof out.config === 'object') {
        // The clone refuses these fields outright; off is the double's default, and the clone's behaviour.
        delete out.config.legacy_omit_capability;
        delete out.config.drop_uncategorized_blocks;
        if ('renderer_egress_ips' in out.config) out.config.renderer_egress_ips = caller(out.config.renderer_egress_ips);
    }
    for (const p of Array.isArray(out.projects) ? out.projects : []) {
        if (!p || typeof p !== 'object') continue;
        p.id = mapProject(ctx, p.id);
        if (p.machine_translate_new_phrases === undefined) p.machine_translate_new_phrases = true;
        for (const b of Array.isArray(p.blocks) ? p.blocks : []) {
            if (b && typeof b === 'object' && (b.content === undefined || b.content === null)) b.content = NO_CONTENT;
        }
    }
    for (const k of Array.isArray(out.keys) ? out.keys : []) {
        if (!k || typeof k !== 'object') continue;
        k.key = mapKey(ctx, k.key);
        if (typeof k.project === 'string') k.project = mapProject(ctx, k.project);
        if ('ip_allowlist' in k) k.ip_allowlist = caller(k.ip_allowlist);
    }
    delete out.faults;
    return out;
}

// ---------------------------------------------------------------------------------------
// Talking to the clone and the double
// ---------------------------------------------------------------------------------------

const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection', 'content-length', 'accept-encoding']);

function requestHeaders(req) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return headers;
}

async function relay(res, response, rewrite = (text) => text) {
    const headers = {};
    response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name) && name !== 'content-encoding' && name !== 'set-cookie') headers[name] = value;
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status === 204 || response.status === 304 || bytes.length === 0) {
        res.writeHead(response.status, headers);
        return res.end();
    }
    const textual = /json|text/.test(response.headers.get('content-type') ?? '');
    const body = textual ? Buffer.from(rewrite(bytes.toString('utf8')), 'utf8') : bytes;
    res.writeHead(response.status, { ...headers, 'content-length': body.length });
    res.end(body);
}

async function fixtureCall(method, path, body) {
    const response = await fetch(`${target}/__fixture${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // An answer that is not JSON is reported as text.
    }
    return { status: response.status, text, json };
}

async function resetClone(ctx) {
    if (ctx?.mode !== 'clone' || !ctx.fixture) return;
    const { status, text } = await fixtureCall('POST', '/reset', { fixture: ctx.fixture });
    if (status !== 200) log({ event: 'reset_failed', fixture: ctx.fixture, status, body: text });
}

// ---------------------------------------------------------------------------------------
// The setup namespace
// ---------------------------------------------------------------------------------------

const double = await startDouble();
let current = context('clone');

async function seed(doc) {
    const reasons = doubleOnly(doc);
    if (reasons.length) {
        const response = await fetch(`${double.origin}/__fixture/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
        const answer = await response.json();
        log({ event: 'seed', to: 'double', reasons, status: response.status });
        if (response.status !== 200) return [response.status, answer];
        await resetClone(current);
        current = context('double');
        return [200, { ok: true }];
    }
    const ctx = context('clone');
    const { status, text, json } = await fixtureCall('POST', '/seed', translateSeed(ctx, doc));
    if (status !== 200 || typeof json?.data?.fixture !== 'string') {
        log({ event: 'seed', to: 'clone', refused: true, status, body: unmap(ctx, text) });
        // The double refuses a seed it cannot hold with 400, whatever the reason.
        return [400, { ok: false, error: `the clone refused the seed (${status}): ${unmap(ctx, text)}` }];
    }
    ctx.fixture = json.data.fixture;
    ctx.faults = (Array.isArray(doc.faults) ? doc.faults : []).map((f) => ({ ...f, times: f.times ?? 1 }));
    log({ event: 'seed', to: 'clone', fixture: ctx.fixture });
    await resetClone(current);
    current = ctx;
    return [200, { ok: true }];
}

async function fixtureRoute(req, res, path, raw) {
    if (current.mode === 'double' && !(req.method === 'POST' && path === '/seed')) {
        const response = await fetch(`${double.origin}/__fixture${path}`, { method: req.method, headers: requestHeaders(req), body: raw.length ? raw : undefined });
        return relay(res, response);
    }
    const body = (() => {
        try {
            return raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
            return undefined;
        }
    })();
    if (req.method === 'POST' && path === '/seed') return send(res, ...(await seed(body ?? {})));
    if (req.method === 'POST' && path === '/reset') {
        await resetClone(current);
        current = context('clone');
        return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/clock') {
        const seconds = Number(body?.advance_seconds ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0) return send(res, 400, { ok: false, error: 'advance_seconds must be >= 0' });
        await sleep(seconds * 1000);
        return send(res, 200, { ok: true, now: new Date().toISOString() });
    }
    if (req.method === 'GET' && path === '/state') {
        if (!current.fixture) return send(res, 200, { projects: {}, hints: [] });
        const { status, text, json } = await fixtureCall('GET', `/state?fixture=${encodeURIComponent(current.fixture)}`);
        if (status !== 200 || !json?.data) return send(res, 502, { ok: false, error: `the clone's state answered ${status}: ${unmap(current, text)}` });
        const accepted = JSON.parse(unmap(current, JSON.stringify(json.data)));
        for (const project of Object.values(accepted.projects ?? {})) {
            for (const block of project.blocks ?? []) if (block.content === NO_CONTENT) block.content = null;
        }
        return send(res, 200, accepted);
    }
    return send(res, 404, { ok: false, error: 'no such fixture route' });
}

// ---------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------

function takeFault(ctx, method, path) {
    const fault = ctx.faults.find((f) => f.times > 0 && f.method === method && f.path === path);
    if (!fault) return null;
    fault.times -= 1;
    return fault;
}

/** A route parameter, percent-decoded as the router decodes it; one that does not decode is taken as written. */
function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** The request as the clone should see it: the fixture's ids in place of the test's, from the fixture's own address. */
function rewriteRequest(ctx, req, url, raw) {
    let pathname = url.pathname.replace(/^(\/api\/authorize-project\/)([^/]+)$/, (_, head, id) => head + encodeURIComponent(mapProject(ctx, decodeSegment(id))));
    const search = url.search.replace(/([?&]project_id=)([^&]*)/g, (_, head, value) => {
        const id = decodeSegment(value.replace(/\+/g, ' '));
        return head + (id === '' ? value : encodeURIComponent(mapProject(ctx, id)));
    });
    let body = raw.length ? raw : undefined;
    if (body) {
        try {
            const json = JSON.parse(raw.toString('utf8'));
            if (json && typeof json === 'object' && !Array.isArray(json) && typeof json.project_id === 'string' && json.project_id !== '') {
                body = Buffer.from(JSON.stringify({ ...json, project_id: mapProject(ctx, json.project_id) }), 'utf8');
            }
        } catch {
            // A body that is not JSON goes as it came.
        }
    }
    const headers = requestHeaders(req);
    const key = headers['x-authorization'];
    if (typeof key === 'string' && key.trim() !== '') headers['x-authorization'] = key.replace(key.trim(), mapKey(ctx, key));
    headers['x-forwarded-for'] = ctx.address;
    // The fixture whose config a request runs with when its key names none: no key, an unknown key, a key with no project.
    if (ctx.fixture) headers['x-sdk-fixture'] = ctx.fixture;
    return { url: `${target}${pathname}${search}`, headers, body };
}

async function api(req, res, url, raw) {
    const ctx = current;
    if (ctx.mode === 'double') {
        const response = await fetch(`${double.origin}${url.pathname}${url.search}`, { method: req.method, headers: requestHeaders(req), body: raw.length ? raw : undefined, redirect: 'manual' });
        return relay(res, response);
    }
    const fault = takeFault(ctx, req.method, url.pathname.slice('/api'.length));
    if (fault) {
        if (fault.delay_ms) await sleep(fault.delay_ms);
        if (fault.drop) return req.socket.destroy();
        // Something in front of the API answering in its place: a proxy's error page, a captive portal.
        if (fault.body !== undefined) {
            res.writeHead(fault.status ?? 200, { 'Content-Type': fault.content_type ?? 'application/json', 'Content-Length': Buffer.byteLength(fault.body) });
            return res.end(fault.body);
        }
        if (fault.status) return send(res, fault.status, statusError(fault.status));
    }
    const forwarded = rewriteRequest(ctx, req, url, raw);
    const response = await fetch(forwarded.url, { method: req.method, headers: forwarded.headers, body: forwarded.body, redirect: 'manual' });
    return relay(res, response, (text) => unmap(ctx, text));
}

// ---------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------

function readRaw(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// The clone answers an unknown fixture 404 once it is reachable and trusted; anything else stops here.
const probe = await fixtureCall('GET', `/state?fixture=${randomUUID()}`).catch((error) => ({ status: 0, text: String(error?.cause ?? error) }));
if (probe.status !== 404) {
    process.stderr.write(`forwarder: ${target}/__fixture is not an SDK test clone's (answered ${probe.status}: ${probe.text.slice(0, 300)})\n`);
    double.child.kill('SIGTERM');
    process.exit(2);
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const raw = await readRaw(req);
    try {
        if (url.pathname.startsWith('/__fixture/')) return await fixtureRoute(req, res, url.pathname.slice('/__fixture'.length), raw);
        if (!url.pathname.startsWith('/api/')) return send(res, 404, apiError('not_found', 'Resource not found'));
        return await api(req, res, url, raw);
    } catch (error) {
        // The clone or the double closed the connection, or could not be reached: the caller sees the same.
        log({ event: 'connection_lost', method: req.method, path: url.pathname, error: String(error?.cause ?? error) });
        req.socket.destroy();
    }
});

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 0;
server.listen(port, '127.0.0.1', () => {
    const { port: bound } = server.address();
    process.stdout.write(
        JSON.stringify({
            ready: true,
            base_url: `http://127.0.0.1:${bound}/api`,
            fixture_url: `http://127.0.0.1:${bound}/__fixture`,
        }) + '\n'
    );
});

async function shutdown() {
    await Promise.race([resetClone(current).catch(() => {}), sleep(5000)]);
    double.child.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, shutdown);
