import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stand-ins for an SDK test clone and its langsys checkout, for the contract fixture's own tests:
 * the forwarder starts against them as it starts against a real clone, and the stand-in clone
 * records what reaches it.
 */

export type Received = { method: string; path: string; search: URLSearchParams; headers: IncomingHttpHeaders; body: string };

export interface StandInClone {
    /** Its origin, once `listen` has resolved. */
    url: string;
    /** What reached its API, in order, but for the owners' reads of its seed. */
    api: Received[];
    /** The owners' reads of its seed, in order. */
    owner: Received[];
    /** How it answers instead of its default, until `clear`. */
    answer: null | ((r: Received, res: ServerResponse) => void);
    /** Holds a seed as the clone's seeder reads it, in place of any it held, until it is given another. */
    seed(document: SeedDocument): void;
    listen(): Promise<void>;
    close(): Promise<void>;
    clear(): void;
}

type SeedDocument = { projects: Record<string, any>[]; keys: Record<string, any>[] };

const formatLocale = (locale: string) => locale.toLowerCase().replaceAll('_', '-');

/**
 * A project owner's read of a seed the stand-in holds, answered as the clone answers it: the key
 * listing, the project's settings, the catalog at a locale, the catalog's rows, a block's markup,
 * and a phrase's translation at the base locale. Null when the read
 * is not one of those, or the token is not the project's owner's.
 */
function ownerRead(seed: SeedDocument, r: Received): [number, unknown] | null {
    if (r.method !== 'GET') return null;
    const token = /^Bearer (.+)$/.exec(String(r.headers.authorization ?? ''))?.[1];
    const owned = seed.projects.filter((p) => p.user?.token === token);
    const item = /^\/api\/translatable-items\/stand-in-(block|phrase)-(.+)$/.exec(r.path);
    if (item) {
        const name = decodeURIComponent(item[2]!);
        if (item[1] === 'block') {
            const block = owned.flatMap((p) => p.blocks ?? []).find((b: any) => b.custom_id === name);
            return block ? [200, { status: true, data: { custom_id: block.custom_id, content: block.content } }] : null;
        }
        const project = owned.find((p) => (p.phrases ?? []).some((ph: any) => ph.phrase === name));
        const phrase = project?.phrases.find((ph: any) => ph.phrase === name);
        if (!phrase) return null;
        const base = formatLocale(project!.base_locale ?? 'en-us');
        const stored = Object.entries(phrase.translations ?? {}).find(([l]) => formatLocale(l) === base);
        return [200, { status: true, data: { phrase: phrase.phrase, translation: stored ? stored[1] : null } }];
    }
    const shown = /^\/api\/projects\/([^/]+)$/.exec(r.path);
    if (shown) {
        const project = owned.find((p) => p.id === decodeURIComponent(shown[1]!));
        if (!project) return null;
        const locales = { base_locale: project.base_locale ?? 'en-us', target_locales: project.target_locales ?? [], discovery_base_locale_only: project.discovery_base_locale_only ?? false };
        const machine = project.machine_translate_new_phrases ?? false;
        return [200, { status: true, data: { id: project.id, website_url: project.website_url ?? null, settings: { locales, ai_translator: { machine_translate_new_phrases: machine, use_machine_translations: machine } } } }];
    }
    const project = owned.find((p) => p.id === r.search.get('project_id'));
    if (!project) return null;
    const category = (c: string | null | undefined) => c || '__uncategorized__';
    if (r.path === '/api/api-keys') {
        const keys = seed.keys.filter((k) => k.project === project.id);
        return [
            200,
            {
                status: true,
                data: keys.map((k) => ({
                    id: k.id,
                    type: k.type,
                    ip_allowlist: k.ip_allowlist?.length ? k.ip_allowlist : null,
                    active: true,
                    write_grant_secret_set_at: k.write_grant_secret ? 1759363200 : null,
                    project: { id: project.id },
                })),
            },
        ];
    }
    if (r.path !== '/api/translations' && r.path !== '/api/translations/data') return null;
    if (project.subscription_suspended) return [402, { status: false, error: { message: 'Subscription is suspended.', code: 'subscription_suspended' } }];
    const data: Record<string, any> = {};
    if (r.path === '/api/translations/data') {
        for (const p of project.phrases ?? []) (data[category(p.category)] ??= []).push({ id: `stand-in-phrase-${encodeURIComponent(p.phrase)}`, type: 'phrase', phrase: p.phrase, category: p.category ?? null });
        for (const b of project.blocks ?? []) (data[category(b.category)] ??= []).push({ id: `stand-in-block-${encodeURIComponent(b.custom_id)}`, type: 'content_block', custom_id: b.custom_id, category: b.category ?? null });
        return [200, { status: true, data }];
    }
    const locale = formatLocale(r.search.get('locale') ?? '');
    // At the base locale the catalog serves the phrase; the API serves a stored ICU message in its place, which the stand-in does not tell apart.
    const value = (p: { phrase: string; translatable?: boolean; translations?: Record<string, string> }) => {
        if (p.translatable === false) return null;
        if (locale === formatLocale(project.base_locale ?? 'en-us')) return p.phrase;
        const given = Object.entries(p.translations ?? {}).find(([l]) => formatLocale(l) === locale);
        return given ? given[1] : null;
    };
    for (const p of project.phrases ?? []) (data[category(p.category)] ??= {})[p.phrase] = value(p);
    for (const b of project.blocks ?? []) (data[category(b.category)] ??= {})[b.custom_id] = Object.fromEntries((b.phrases ?? []).map((p: any) => [p.phrase, value(p)]));
    return [200, { status: true, data }];
}

/**
 * An SDK test clone's API, recorded. By default it accepts everything: a reference list answers
 * a table of its own, and any other route echoes the path, project and key it saw. Like a Langsys
 * API, it answers a catalog read with no key 401 `unauthenticated`, which the forwarder asks at
 * start. A project owner's read of the seed it holds is answered from that seed, so a case the
 * forwarder names confirms its seed as it does on a clone.
 */
export function standInClone(): StandInClone {
    let held: SeedDocument = { projects: [], keys: [] };
    const json = (res: ServerResponse, status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
    };
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const url = new URL(req.url ?? '/', 'http://stand-in.local');
            const body = Buffer.concat(chunks).toString('utf8');
            const received = { method: req.method ?? 'GET', path: url.pathname, search: url.searchParams, headers: req.headers, body };
            const owners = ownerRead(held, received);
            if (owners) {
                stub.owner.push(received);
                return json(res, owners[0], owners[1]);
            }
            if (url.pathname === '/api/translations' && !req.headers['x-authorization']) {
                return json(res, 401, { status: false, error: { message: 'Unauthenticated.', code: 'unauthenticated', template: 'Unauthenticated.' } });
            }
            stub.api.push(received);
            if (stub.answer) return stub.answer(received, res);
            if (/^\/api\/(countries|currencies)\//.test(url.pathname)) return json(res, 200, { status: true, data: [{ code: 'CLONE', label: 'The clone’s own table' }] });
            if (/^\/api\/locales(\/flat|\/data)?$/.test(url.pathname)) return json(res, 200, { status: true, data: { CLONE: [] } });
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
    const stub: StandInClone = {
        url: '',
        api: [],
        owner: [],
        answer: null,
        seed(document) {
            held = document;
        },
        listen: () =>
            new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', () => {
                    stub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
                    resolve();
                })
            ),
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
        clear() {
            stub.api = [];
            stub.owner = [];
            stub.answer = null;
        },
    };
    return stub;
}

/** A langsys checkout's hint reader, standing in: it prints the hints `hints.json` holds for the projects named, and refuses an id that is not a UUID. */
export function standInCheckout(): { root: string; setHints(hints: Array<{ project_id: string; url: string }>): void } {
    const root = mkdtempSync(join(tmpdir(), 'clone-root-'));
    mkdirSync(join(root, 'tests', 'Sdk'), { recursive: true });
    writeFileSync(
        join(root, 'tests', 'Sdk', 'accepted-hints.php'),
        `<?php
$ids = array_slice($argv, 1);
foreach ($ids as $id) {
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id)) { fwrite(STDERR, "not a UUID: $id\\n"); exit(2); }
}
$all = json_decode(@file_get_contents(__DIR__ . '/hints.json') ?: '[]', true);
echo json_encode(['hints' => array_values(array_filter($all, fn ($h) => in_array($h['project_id'], $ids, true)))]);
`
    );
    const setHints = (hints: Array<{ project_id: string; url: string }>) => writeFileSync(join(root, 'tests', 'Sdk', 'hints.json'), JSON.stringify(hints));
    setHints([]);
    return { root, setHints };
}

/** Points the fixture helper at the stand-ins, as the suite points it at a clone. */
export function useStandIns(stub: StandInClone, checkout: { root: string }) {
    process.env.LANGSYS_CONTRACT_TARGET = stub.url;
    process.env.LANGSYS_CONTRACT_CLONE_ROOT = checkout.root;
    delete process.env.LANGSYS_CONTRACT_LOG;
}
