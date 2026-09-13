import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * SSR strategy cases, each in a FRESH PROCESS, as CONF-3 requires.
 *
 * CONF-3: "SSR strategy cases MUST run in a fresh process each. The SDK singleton is
 * process-wide... Shared-process SSR assertions contaminate each other silently."
 *
 * These cases used to share one file in `write-lane`, and so one process. Measured
 * on vitest 4.1.7: two test files ran under two different pids, and every case inside
 * a file shared its file's pid. Per-file isolation is therefore real but belongs to
 * the pool configuration, and `isolate: false` would quietly merge the processes with
 * nothing going red. So each case here spawns its own Node process instead, which
 * holds whatever vitest is configured to do.
 *
 * They run against the BUILT `dist`. That is both the shipped artifact and the real
 * server path: plain Node, no DOM, no shim. `npm test` builds first; a missing `dist`
 * fails loudly rather than skipping.
 *
 * The SSR-2 grant case is included because it writes the config singleton through
 * `LangsysAppAPI.setup`, which is exactly the contamination CONF-3 names. In the
 * shared file it had to undo itself by calling `setup` again without the grant: a
 * manual reset that a fresh process makes unnecessary, and one a later edit could
 * drop without any failure showing.
 */

const DIST = join(process.cwd(), 'dist', 'index.mjs');
const SCRATCH = join(process.cwd(), 'node_modules', '.langsys-ssr-case.mjs');
const LF = String.fromCharCode(10);

const CHILD = `const [, , dist, mode] = process.argv;
const m = await import(dist);
const cfg = (extra) => Object.assign({ projectid: 'p', key: 'k', sUserLocale: m.createSignal('en-US'), baseLocale: 'en' }, extra || {});
function run(strategy, phrases) {
    const tr = new m.Translations(Object.assign(cfg(), { ssrTokenStrategy: strategy }));
    tr.applyWriteEnabled(true);
    for (const p of phrases) tr.t(p, 'UI');
    const q = tr.missingTokens;
    if (!Array.isArray(q)) throw new Error('missingTokens is not an array; the probe no longer reads the queue');
    return q.map((x) => x.token);
}
let tokens;
if (mode === 'client') tokens = run('client', ['SSR client phrase']);
else if (mode === 'server') tokens = run('server', ['SSR server phrase']);
else if (mode === 'auto') tokens = run('auto', Array.from({ length: 12 }, (_, i) => 'Auto ' + i));
else if (mode === 'grant') { m.LangsysAppAPI.setup(cfg({ writeGrant: () => 'jwt' })); tokens = run('server', ['SSR phrase with a grant configured']); }
else if (mode === 'shared-grant-then-server') { m.LangsysAppAPI.setup(cfg({ writeGrant: () => 'jwt' })); run('server', ['first']); tokens = run('server', ['SSR server phrase']); }
else throw new Error('unknown mode ' + mode);
console.log(JSON.stringify({ pid: process.pid, tokens }));
process.exit(0);`;

interface CaseResult {
    pid: number;
    tokens: string[];
}

function runCase(mode: string): CaseResult {
    if (!existsSync(DIST)) {
        throw new Error('dist/index.mjs is missing: run `npm run build` first. These cases run the shipped artifact.');
    }
    const out = execFileSync(process.execPath, [SCRATCH, DIST, mode], { encoding: 'utf8' });
    return JSON.parse(out.trim().split(LF).pop()!) as CaseResult;
}

const results: Record<string, CaseResult> = {};
let sharedControl: CaseResult;

beforeAll(() => {
    writeFileSync(SCRATCH, CHILD);
    for (const mode of ['client', 'server', 'auto', 'grant']) results[mode] = runCase(mode);
    sharedControl = runCase('shared-grant-then-server');
}, 30_000);

describe('SSR-1: each strategy collects only what it can actually send', () => {
    it("'client' does not collect: the post-hydration flush reads a different process", () => {
        expect(results.client!.tokens).toEqual([]);
    });

    it("'server' does collect, because it flushes in-process", () => {
        expect(results.server!.tokens).toEqual(['SSR server phrase']);
    });

    it("'auto' collects only up to its flush threshold", () => {
        expect(results.auto!.tokens).toHaveLength(5);
    });
});

describe('SSR-2: a configured grant makes the server lane unusable, so nothing is collected', () => {
    it('does not collect under SSR when a grant is configured', () => {
        // canWrite() refuses the SSR lane whenever a grant is configured, so
        // collecting anyway would rebuild the undrainable plateau: nothing can send
        // it, and the writeEnabled release path never fires server-side.
        expect(results.grant!.tokens).toEqual([]);
    });
});

describe('CONF-3: the isolation is real, not ceremonial', () => {
    it('every case ran in a process of its own, none of them this one', () => {
        const pids = Object.values(results).map((r) => r.pid);
        expect(pids).toHaveLength(4);
        expect(new Set(pids).size).toBe(4);
        expect(pids).not.toContain(process.pid);
    });
});

describe('CONF-3 control: one shared process really does contaminate', () => {
    it('the grant from the SSR-2 case silently stops a later server case from collecting', () => {
        // Measured, and the reason the isolation above is load-bearing rather than
        // ceremony. In ITS OWN process the 'server' case collects its phrase. In ONE
        // process, after the grant case has configured the singleton, the very same
        // 'server' case collects nothing. Nothing throws and nothing warns in between.
        //
        // If this goes red because the shared case now DOES collect, the leak is gone.
        // Revisit whether per-case processes are still needed; do not flip the
        // expectation to make it green.
        expect(results.server!.tokens).toEqual(['SSR server phrase']);
        expect(sharedControl.tokens).toEqual([]);
    });
});
