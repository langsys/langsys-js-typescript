import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Starts the contract double (`contract-fixture/server.mjs`) in its own process and hands
 * back what a test needs: the base URL to point the SDK at, and the setup namespace.
 *
 * There is deliberately no accessor for what the double received. A test reads what was
 * registered back through the API's catalog (`held`), as a client reads it (CONF-2).
 * `state()` returns accepted state only, for what no route a project key can call reads
 * back: the hints the server stored, and a block's stored content.
 */
export interface ContractFixture {
    baseUrl: string;
    fixtureUrl: string;
    seed(doc: unknown): Promise<void>;
    reset(): Promise<void>;
    /**
     * What the catalog serves for a project at a locale, read with `key`: phrases by text, blocks by
     * custom id with their phrases, every category. Sorted, since the API promises no order.
     */
    held(key: string, project: string, locale: string): Promise<HeldCatalog>;
    state(): Promise<AcceptedState>;
    advanceClock(seconds: number): Promise<void>;
    stop(): Promise<void>;
}

/** The fetch this module loaded with: a test's reads are not the SDK's traffic, so a test spying on `fetch` never sees them. */
const directFetch = globalThis.fetch.bind(globalThis);

export interface HeldCatalog {
    phrases: string[];
    blocks: Record<string, string[]>;
}

export interface AcceptedState {
    projects: Record<
        string,
        {
            phrases: Array<{ category: string | null; phrase: string; translatable: boolean; translations: Record<string, string | null> }>;
            blocks: Array<{
                category: string | null;
                custom_id: string;
                content: string | null;
                label: string | null;
                phrases: Array<{ phrase: string; translatable: boolean; translations: Record<string, string | null> }>;
            }>;
        }
    >;
    hints: Array<{ project_id: string; url: string }>;
}

/**
 * `env` is added to the double's environment, for a case that needs a host setting such as its locale.
 *
 * With `LANGSYS_CONTRACT_TARGET` set to an SDK test clone's origin, the double runs in its
 * forwarding mode (`contract-fixture/forwarder.mjs`) and the clone answers the API.
 * `LANGSYS_CONTRACT_LOG` names the file the forwarder logs its seeds to.
 */
export async function startContractFixture(env: Record<string, string> = {}): Promise<ContractFixture> {
    const target = process.env.LANGSYS_CONTRACT_TARGET;
    const log = process.env.LANGSYS_CONTRACT_LOG;
    const args = target
        ? [join(process.cwd(), 'contract-fixture', 'forwarder.mjs'), '--target', target, ...(log ? ['--log', log] : [])]
        : [join(process.cwd(), 'contract-fixture', 'server.mjs')];
    const child: ChildProcess = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });

    const ready = await new Promise<{ base_url: string; fixture_url: string }>((resolve, reject) => {
        let buffered = '';
        const timer = setTimeout(() => reject(new Error('contract fixture did not report ready within 10s')), 10_000);
        child.stdout!.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8');
            const newline = buffered.indexOf(String.fromCharCode(10));
            if (newline < 0) return;
            clearTimeout(timer);
            try {
                resolve(JSON.parse(buffered.slice(0, newline)));
            } catch (err) {
                reject(err);
            }
        });
        child.once('exit', (code) => reject(new Error(`contract fixture exited early with code ${code}`)));
    });

    const post = async (path: string, body: unknown) => {
        const res = await fetch(ready.fixture_url + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) throw new Error(`fixture ${path} answered ${res.status}: ${await res.text()}`);
    };

    return {
        baseUrl: ready.base_url,
        fixtureUrl: ready.fixture_url,
        seed: (doc) => post('/seed', doc),
        reset: () => post('/reset', {}),
        advanceClock: (seconds) => post('/clock', { advance_seconds: seconds }),
        held: async (key, project, locale) => {
            const query = `project_id=${encodeURIComponent(project)}&locale=${encodeURIComponent(locale)}`;
            const res = await directFetch(`${ready.base_url}/translations?${query}`, { headers: { 'x-Authorization': key, accept: 'application/json' } });
            const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
            if (!res.ok || !body) throw new Error(`the catalog for ${project} at ${locale} answered ${res.status}`);
            const held: HeldCatalog = { phrases: [], blocks: {} };
            const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {};
            for (const entries of Object.values(data as Record<string, unknown>)) {
                if (!entries || typeof entries !== 'object') continue;
                for (const [name, value] of Object.entries(entries)) {
                    if (value && typeof value === 'object') held.blocks[name] = Object.keys(value);
                    else held.phrases.push(name);
                }
            }
            held.phrases.sort();
            for (const id of Object.keys(held.blocks)) held.blocks[id]!.sort();
            return held;
        },
        state: async () => (await (await fetch(ready.fixture_url + '/state')).json()) as AcceptedState,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once('exit', () => resolve());
                child.kill('SIGTERM');
            }),
    };
}
