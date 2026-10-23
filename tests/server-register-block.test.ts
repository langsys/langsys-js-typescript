import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `registerBlock` on a server outside every request scope (no `window`, as here).
 *
 * There is no scope to hold the block for `close()`, and in the pattern where the client
 * initialises, the server never calls `init()`, so `ready()` never settles. Waiting on it
 * kept a reaction holding the tree, params and options per call for the life of the
 * process. It resolves at once instead, registers nothing, and says so in a debug notice.
 *
 * Retention is measured, not inferred: each tree is held by a WeakRef, every strong
 * reference is dropped, and the collector runs.
 */

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

const N = 300;
const tree = (i: number) => [
    { tag: 'p', attrs: {}, children: [{ text: `Sentence number ${i}.` }] },
    { tag: 'p', attrs: {}, children: [{ text: 'A second sentence.' }] },
];

let requests: number;

async function fresh() {
    vi.resetModules();
    requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
        requests += 1;
        throw new Error('no request is expected');
    }));
    const { registerBlock } = await import('../src/block-tree.js');
    const { createRequestScope } = await import('../src/request-scope.js');
    const { settleNotices } = await import('../src/notices.js');
    const { logger } = await import('../src/logger.js');
    return { registerBlock, createRequestScope, settleNotices, logger };
}

/**
 * Issue `count` registrations, each over a tree only the call itself holds. A plain function,
 * so no async frame keeps the last tree alive after it returns.
 */
function issue(registerBlock: (nodes: ReturnType<typeof tree>, options?: Record<string, unknown>) => Promise<void>, count: number) {
    const refs: WeakRef<object>[] = [];
    const calls: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
        const nodes = tree(i);
        refs.push(new WeakRef(nodes));
        calls.push(registerBlock(nodes, { category: 'UI', params: { name: `user-${i}` } }));
    }
    return { refs, calls };
}

/** Let pending jobs finish, then collect, a few times over: a WeakRef holds through its job. */
async function collect() {
    for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
    }
}

beforeEach(() => {
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('registerBlock on a server outside every request scope', () => {
    it('resolves at once, sends nothing, and retains none of the trees it was given', async () => {
        const { registerBlock } = await fresh();
        // eslint-disable-next-line prefer-const
        let { refs, calls } = issue(registerBlock as never, N);
        // The measurement's own control: a tree something still holds survives the collector.
        const kept = tree(-1);
        const keptRef = new WeakRef(kept);

        const settled = await Promise.race([
            Promise.all(calls).then(() => 'resolved'),
            new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
        ]);
        calls = [];
        await collect();

        expect(settled).toBe('resolved');
        expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
        expect(keptRef.deref()).toBe(kept);
        expect(requests).toBe(0);
    });

    it('says so once, as a debug notice', async () => {
        const { registerBlock, settleNotices, logger } = await fresh();
        logger.debugEnabled = true;
        const log = vi.mocked(console.log);
        try {
            await registerBlock(tree(1));
            await registerBlock(tree(2));
            settleNotices();
            const said = log.mock.calls.filter((call) => call.join(' ').includes('outside a request scope'));
            expect(said).toHaveLength(1);
        } finally {
            logger.debugEnabled = false;
        }
    });

    it('control: inside a request scope the scope holds each block for close(), and the trees are still collected', async () => {
        const { registerBlock, createRequestScope } = await fresh();
        const scope = await createRequestScope({ locale: 'en-us', catalog: {} as never });

        // Synchronously inside run(): with no AsyncLocalStorage the scope is current only there.
        const { refs, calls } = scope.run(() => issue(registerBlock as never, N));
        await Promise.all(calls);
        await collect();

        expect((scope as unknown as { blockMisses: Map<string, unknown> }).blockMisses.size).toBe(N);
        expect(refs.filter((ref) => ref.deref() !== undefined)).toHaveLength(0);
        expect(requests).toBe(0);
    });
});
