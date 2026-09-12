import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as pure from '../src/pure.js';

/**
 * `langsys-js-typescript/pure` must stay importable and callable where there is
 * no DOM — a server, a worker, an edge runtime, a build script.
 *
 * It exists because `langsys-js-server` was otherwise sed-extracting the
 * identity functions out of a published tarball into a vendored `@ts-nocheck`
 * copy, the main entry being unusable there. A copy cannot track a rule change,
 * and that one predated every content-id decision made this month.
 *
 * The guard runs in a CHILD PROCESS, deliberately. Installing throwing getters
 * for `window`/`document`/… on this process's `globalThis` would perturb vitest
 * and every other test in the file; a child gives a genuinely bare Node with
 * nothing else loaded, which is the environment being claimed.
 *
 * Exercising the BUILT artifact rather than `src/` is also deliberate: what a
 * consumer resolves through the exports map is `dist/pure.mjs` and
 * `dist/pure.js`, and bundling is where a stray import gets pulled back in.
 */

const GUARD = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TRAPPED = ['window','document','navigator','localStorage','sessionStorage','self','top','parent'];
for (const name of TRAPPED) Object.defineProperty(globalThis, name, {
    configurable: true,
    get() { throw new Error('DOM_TOUCHED:' + name); },
    set() { throw new Error('DOM_TOUCHED:set:' + name); },
});
const [, , target, phase, kind] = process.argv;
try {
    const m = kind === 'cjs' ? require(target) : await import(target);
    if (phase === 'import') { console.log('IMPORT_CLEAN exports=' + Object.keys(m).length); process.exit(0); }
    let called = 0;
    for (const [, v] of Object.entries(m)) {
        if (typeof v !== 'function') continue;
        try { v('x', ['y']); called++; } catch (e) {
            // A TypeError from deliberately wrong arguments is fine. A DOM touch
            // is the thing being looked for, so it must not be swallowed here.
            if (String(e.message).startsWith('DOM_TOUCHED')) throw e;
            called++;
        }
    }
    console.log('CALLS_CLEAN called=' + called); process.exit(0);
} catch (e) {
    console.log('TRIPPED ' + String(e.message).split('\\n')[0]); process.exit(3);
}
`;

const SCRATCH = join(process.cwd(), 'node_modules', '.langsys-dom-guard.mjs');
const DIST = join(process.cwd(), 'dist');

function runGuard(artifact: string, phase: 'import' | 'call', kind: 'esm' | 'cjs' = 'esm') {
    try {
        const out = execFileSync(process.execPath, [SCRATCH, join(DIST, artifact), phase, kind], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out: out.trim() };
    } catch (err) {
        const e = err as { status?: number; stdout?: string };
        return { code: e.status ?? 1, out: (e.stdout ?? '').trim() };
    }
}

beforeAll(() => {
    writeFileSync(SCRATCH, GUARD);
});

describe('the guard can actually catch a DOM touch', () => {
    // Without this, every "clean" result below could be a guard that never
    // fires. The main entry supplies a real positive control — no planted one
    // needed — and the distinction is worth stating precisely: the main entry
    // IMPORTS cleanly too. It is CALLING its exports that reaches `window`,
    // via the localStorage probe in `persist`.
    it('the main entry trips it when its exports are called', () => {
        const r = runGuard('index.mjs', 'call');
        expect(r.code).toBe(3);
        expect(r.out).toContain('DOM_TOUCHED');
    });

    it('…and the main entry imports cleanly, so "clean import" is not the claim', () => {
        const r = runGuard('index.mjs', 'import');
        expect(r.code).toBe(0);
        expect(r.out).toContain('IMPORT_CLEAN');
    });
});

describe('/pure touches no DOM', () => {
    it('imports cleanly as ESM', () => {
        const r = runGuard('pure.mjs', 'import');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('IMPORT_CLEAN');
    });

    it('imports cleanly as CJS, which is half the exports map', () => {
        const r = runGuard('pure.js', 'import', 'cjs');
        expect(r.code, r.out).toBe(0);
    });

    it('survives every exported function being called', () => {
        // A clean import proves only that nothing ran at module scope. The
        // requirement is no DOM on any exported CALL PATH.
        const r = runGuard('pure.mjs', 'call');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('CALLS_CLEAN');
    });
});

describe('the export list is a contract', () => {
    // langsys-js-server imports these by name and swaps its vendored copy for
    // them. A removal should fail here, not in their build.
    const EXPECTED = [
        'CONTENT_BLOCK_MARKER_ATTR',
        'CONTENT_BLOCK_MARKER_ATTRS',
        'CONTENT_BLOCK_MARKER_ATTR_LEGACY',
        'NON_TRANSLATABLE_ELEMENTS',
        'PHRASE_MARKER_ATTR',
        'PHRASE_MARKER_ATTRS',
        'PHRASE_MARKER_ATTR_LEGACY',
        'TRANSLATABLE_ATTRIBUTES',
        'canonicalContentBlockJson',
        'canonicalizeLocale',
        'generateCustomId',
        'generateLegacyCustomId',
        'interpolate',
        'isEmpty',
        'isICU',
        'maximizedLangScript',
        'md5',
        'md5Legacy',
        'normalizeMarkupPlaceholders',
        'normalizeTokenText',
    ];

    it('exports exactly the documented set', () => {
        expect(Object.keys(pure).sort()).toEqual([...EXPECTED].sort());
    });

    it('and the identity pieces are the same functions the DOM path uses', async () => {
        // Not a parallel copy: if /pure re-implemented any of these, the server
        // and the browser would agree right up until one of them changed.
        const contentBlock = await import('../src/content-block.js');
        expect(pure.generateCustomId).toBe(contentBlock.generateCustomId);
        expect(pure.TRANSLATABLE_ATTRIBUTES).toBe(contentBlock.TRANSLATABLE_ATTRIBUTES);
        expect(pure.normalizeTokenText).toBe(contentBlock.normalizeTokenText);
    });

    it('carries PHP’s 27 attributes, in PHP’s order', () => {
        // Order is identity: `custom_id` hashes the token array, so reordering
        // silently re-keys every block using one of them.
        expect(pure.TRANSLATABLE_ATTRIBUTES).toHaveLength(27);
        expect(pure.TRANSLATABLE_ATTRIBUTES.slice(15)).toEqual([
            'data-confirm',
            'data-tooltip',
            'data-title',
            'data-content',
            'data-original-title',
            'data-bs-title',
            'data-bs-content',
            'data-loading-text',
            'data-success-message',
            'data-warning-message',
            'data-empty-message',
            'data-placeholder',
        ]);
    });
});
