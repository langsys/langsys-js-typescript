import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

/**
 * Starts the contract double (`contract-fixture/server.mjs`) in its own process and hands
 * back what a test needs: the base URL to point the SDK at, and the setup namespace.
 *
 * There is deliberately no accessor for what the double received. `state()` returns
 * accepted state only, which is what CONF-1 lets a test assert on.
 */
export interface ContractFixture {
    baseUrl: string;
    fixtureUrl: string;
    seed(doc: unknown): Promise<void>;
    reset(): Promise<void>;
    state(): Promise<AcceptedState>;
    advanceClock(seconds: number): Promise<void>;
    stop(): Promise<void>;
}

export interface AcceptedState {
    projects: Record<
        string,
        {
            phrases: Array<{ category: string | null; phrase: string; translations: Record<string, string | null> }>;
            blocks: Array<{
                category: string | null;
                custom_id: string;
                content: string | null;
                label: string | null;
                phrases: Array<{ phrase: string; translations: Record<string, string | null> }>;
            }>;
        }
    >;
    hints: Array<{ project_id: string; url: string }>;
}

export async function startContractFixture(): Promise<ContractFixture> {
    const script = join(process.cwd(), 'contract-fixture', 'server.mjs');
    const child: ChildProcess = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });

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
        state: async () => (await (await fetch(ready.fixture_url + '/state')).json()) as AcceptedState,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once('exit', () => resolve());
                child.kill('SIGTERM');
            }),
    };
}
