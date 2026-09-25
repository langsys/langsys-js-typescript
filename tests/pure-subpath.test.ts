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

const TRAPPED_NAMES = [
    // The original eight.
    'window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'self', 'top', 'parent',
    // The hole. Every name below is absent from bare Node, so trapping one can
    // only catch real DOM reach, never a legitimate Node API.
    'Node', 'Element', 'HTMLElement', 'SVGElement', 'Document', 'DocumentFragment',
    'Text', 'Comment', 'CharacterData', 'NodeFilter', 'NodeIterator', 'TreeWalker',
    'Range', 'DOMParser', 'XMLSerializer', 'getComputedStyle', 'MutationObserver',
    'IntersectionObserver', 'ResizeObserver', 'customElements', 'requestAnimationFrame',
    'matchMedia', 'history', 'location', 'screen', 'frames', 'alert', 'XMLHttpRequest',
    'HTMLTemplateElement', 'ShadowRoot', 'CSSStyleSheet',
] as const;

const GUARD = `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TRAPPED = ${JSON.stringify(TRAPPED_NAMES)};
for (const name of TRAPPED) Object.defineProperty(globalThis, name, {
    configurable: true,
    get() { throw new Error('DOM_TOUCHED:' + name); },
    set() { throw new Error('DOM_TOUCHED:set:' + name); },
});
const [, , target, phase, kind, extra] = process.argv;

// BEFORE importing anything: this phase is about the trap itself, not the target.
if (phase === 'selftrap') {
    try {
        // A BARE IDENTIFIER reference, which is how source code touches a DOM
        // global — \`Node.TEXT_NODE\`, not \`globalThis.Node\`. eval is what makes
        // the name a parameter while keeping the reference bare; the value is
        // consumed by String() so nothing here is dead code a runtime may drop.
        const probe = eval('void ' + extra + ', typeof ' + extra);
        console.log('NOT_TRAPPED ' + extra + ' -> ' + String(probe));
        process.exit(0);
    } catch (e) {
        console.log('TRIPPED ' + String(e.message).split('\\n')[0]);
        process.exit(3);
    }
}

try {
    const m = kind === 'cjs' ? require(target) : await import(target);
    if (phase === 'import') { console.log('IMPORT_CLEAN exports=' + Object.keys(m).length); process.exit(0); }
    if (phase === 'varied') {
        // Deliberately exercising the branches a single fixed shape misses:
        // ICU date/number/selectordinal, a non-Latin script, empty and
        // undefined, and a locale needing likely-subtags expansion.
        const probes = [
            () => m.interpolate('{n, plural, one {# day} other {# days}}', { n: 3 }, 'en'),
            () => m.interpolate('{d, date, long}', { d: new Date(0) }, 'en'),
            () => m.interpolate('{amt, number, ::currency/EUR}', { amt: 12.5 }, 'de-de'),
            () => m.interpolate('{n, selectordinal, one {#st} other {#th}}', { n: 1 }, 'en'),
            () => m.interpolate('Hi %name%', { name: 'Ada' }, 'en'),
            () => m.canonicalizeLocale('zh-Hant-TW'),
            () => m.canonicalizeLocale(''),
            () => m.maximizedLangScript('zh-tw'),
            () => m.generateCustomId('', ['']),
            () => m.generateCustomId(undefined, ['x']),
            () => m.generateLegacyCustomId('UI', [String.fromCodePoint(233), String.fromCodePoint(128512)]),
            () => m.normalizeTokenText('a' + String.fromCodePoint(160) + ' b' + String.fromCodePoint(10) + '  c'),
            () => m.normalizeMarkupPlaceholders('%a% and {b}'),
            () => m.encodeRichPhrase([{ text: 'Based on ' }, { children: [{ text: '12 reviews' }], payload: 'EM' }]),
            () => m.encodeRichPhrase([{ children: [{ children: [{ text: 'deep' }], payload: 'B' }], payload: 'A' }]),
            () => m.encodeRichPhrase([]),
            () => m.findUnusedParamKeys(['Hi {a} and %b%'], { a: 1, b: 2, c: 3 }),
            () => m.md5(String.fromCodePoint(128512)),
            () => m.md5Legacy(String.fromCodePoint(128512)),
            () => m.isICU('{n, plural, one {#} other {#}}'),
            () => m.isEmpty(undefined),
        ];
        let ran = 0;
        for (const probe of probes) {
            try { probe(); ran++; } catch (e) {
                if (String(e.message).startsWith('DOM_TOUCHED')) throw e;
                ran++;
            }
        }
        console.log('VARIED_CLEAN probes=' + ran); process.exit(0);
    }
    if (phase === 'nodeish') {
        // Call every export with an argument SHAPED LIKE A DOM NODE, so a walker
        // gets past its argument handling and reaches the DOM global it needs.
        // The fixed \`fn('x', ['y'])\` sweep below cannot: a walker reading
        // \`root.childNodes\` on the string 'x' throws on undefined long before it
        // evaluates \`Node.TEXT_NODE\`, so it never touches a trapped name.
        const leaf = { nodeType: 3, nodeValue: 'x', textContent: 'x', childNodes: [],
            attributes: [], tagName: 'SPAN', getAttribute: () => 'x', hasAttribute: () => false };
        leaf.cloneNode = () => leaf;
        const root = { nodeType: 1, nodeValue: null, textContent: 'x', childNodes: [leaf],
            attributes: [], tagName: 'DIV', getAttribute: () => 'x', hasAttribute: () => false };
        root.cloneNode = () => root;
        let probed = 0;
        for (const [, v] of Object.entries(m)) {
            if (typeof v !== 'function') continue;
            try { v(root, [leaf]); probed++; } catch (e) {
                if (String(e.message).startsWith('DOM_TOUCHED')) throw e;
                probed++;
            }
        }
        console.log('NODEISH_CLEAN probed=' + probed); process.exit(0);
    }
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

/**
 * A hand-written miniature of the exact hazard: a function that walks child nodes
 * and compares against a DOM global. Not taken from `dist`, so it stays a fixed
 * reference point no refactor can quietly defuse.
 */
const WALKER_PROBE = `
export function walk(root) {
    let out = '';
    for (const node of Array.from(root.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue ?? '';
    }
    return out;
}
`;

const SCRATCH = join(process.cwd(), 'node_modules', '.langsys-dom-guard.mjs');
const WALKER = join(process.cwd(), 'node_modules', '.langsys-walker-probe.mjs');
const DIST = join(process.cwd(), 'dist');

function runGuard(
    artifact: string,
    phase: 'import' | 'call' | 'varied' | 'selftrap' | 'nodeish',
    kind: 'esm' | 'cjs' = 'esm',
    extra = ''
) {
    try {
        const target = artifact.startsWith('/') ? artifact : join(DIST, artifact);
        const out = execFileSync(process.execPath, [SCRATCH, target, phase, kind, extra], {
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
    writeFileSync(WALKER, WALKER_PROBE);
});

describe('every name in the trap list is a live trap', () => {
    // WHY THIS EXISTS. The list was eight names — window, document, navigator,
    // storage, self, top, parent — and `encodeRichText` reaches the DOM through
    // none of them: it reads `Node.TEXT_NODE`, and `Node` is NOT a global in bare
    // Node (measured: `'Node' in globalThis` is false on v22). So it would have
    // thrown `ReferenceError: Node is not defined`, the guard's catch would have
    // classified that as "a TypeError from deliberately wrong arguments, fine",
    // and the phase would have reported CALLS_CLEAN.
    //
    // That is the whole failure mode this file was built to prevent, arriving in
    // the file itself: the guard could fail, but not for the case most likely to
    // occur — someone adding a node walker to /pure, which is exactly what the
    // JS Server lane asked for and what prompted the measurement.
    //
    // Parameterised per name rather than sampled, because a longer list is not
    // the same thing as a working one and the only way to tell is to trip each.
    it.each(TRAPPED_NAMES)('%s trips the guard when referenced bare', (name) => {
        const r = runGuard('pure.mjs', 'selftrap', 'esm', name);
        expect(r.code, `${name} was NOT trapped: ${r.out}`).toBe(3);
        expect(r.out).toContain(`DOM_TOUCHED:${name}`);
    });
});

describe('a DOM WALKER is caught, which needed the probe shape and not just the list', () => {
    // MEASURED, and the reason this block exists. Adding `encodeRichText` to
    // /pure — the export the JS Server lane asked for — was checked three ways:
    //
    //   call    + 39-name trap : CALLS_CLEAN  exit 0   <- still missed it
    //   call    +  8-name trap : CALLS_CLEAN  exit 0
    //   nodeish + 39-name trap : DOM_TOUCHED:Node      <- caught
    //
    // So lengthening the trap list did NOT close the hole on its own, which is
    // what the first attempt at this fix assumed. The `call` sweep passes every
    // export `fn('x', ['y'])`, and a walker reading `'x'.childNodes` throws a
    // TypeError on `Array.from(undefined)` before it ever evaluates
    // `Node.TEXT_NODE` — the guard's catch then classifies that as an ordinary
    // wrong-argument error and reports clean. BOTH halves are load-bearing: a
    // trapped name that nothing reaches is not a trap.
    it('the nodeish sweep trips on a walker', () => {
        const r = runGuard(WALKER, 'nodeish');
        expect(r.code, r.out).toBe(3);
        expect(r.out).toContain('DOM_TOUCHED:Node');
    });

    it('…and the fixed-argument sweep does NOT, on the same probe', () => {
        // The negative half, asserted rather than described. If someone later
        // "simplifies" the nodeish phase away, this is the test that says why it
        // was there — and if the call sweep ever does start catching walkers,
        // this fails and the comment above is the thing to correct.
        const r = runGuard(WALKER, 'call');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('CALLS_CLEAN');
    });
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

    it('survives being handed node-shaped arguments', () => {
        // The phase that would catch a DOM walker. /pure's `encodeRichPhrase`
        // takes a node-shaped tree by design, so this is the export most likely
        // to reach for a DOM global one day, and the one this phase watches.
        const r = runGuard('pure.mjs', 'nodeish');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('NODEISH_CLEAN');
    });

    it('survives realistic arguments, not just one fixed shape', () => {
        // The sweep above calls everything as `fn('x', ['y'])`, which reaches a
        // fair amount of code but not the branches that matter: ICU formatting,
        // a non-Latin script, empty and undefined inputs. A call path that only
        // touches the DOM inside an ICU date branch would have passed.
        const r = runGuard('pure.mjs', 'varied');
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('VARIED_CLEAN');
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
        'RESOLVED_MARKER_ATTR',
        'RESOLVED_MARKER_ATTRS',
        'RESOLVED_MARKER_ATTR_LEGACY',
        'TRANSLATABLE_ATTRIBUTES',
        'canonicalContentBlockJson',
        'canonicalizeLocale',
        'encodeRichPhrase',
        'findUnusedParamKeys',
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
        'stripC0Controls',
        'DEFAULT_SERVER_MESSAGE_CATEGORY',
        'LEGACY_FORMATS',
        'SNAPSHOT_FORMAT',
        'SNAPSHOT_VERSION',
        'SnapshotError',
        'buildSnapshot',
        'canonicalSnapshotJson',
        'parseSnapshot',
        'snapshotChecksum',
        'SUPPORTED_LEGACY_FORMATS',
        'LegacyFormatError',
        'convertLegacyCall',
        'convertLegacyPluralForms',
        'convertLegacyValue',
        'createLegacyKeys',
        'SERVER_MESSAGE_CODES',
        'fillTemplate',
        'resolveServerMessages',
        'templateMarkers',
        'toServerMessage',
    ];

    it('exports exactly the documented set', () => {
        expect(Object.keys(pure).sort()).toEqual([...EXPECTED].sort());
    });

    it('and EVERY identity piece is the same object the DOM path uses', async () => {
        // Not a parallel copy: if /pure re-implemented any of these, the server
        // and the browser would agree right up until one of them changed.
        //
        // All fifteen, not a sample. The first version asserted three, so
        // wrapping `generateLegacyCustomId` stayed green — and a sampled
        // identity check is exactly as good as no identity check for the twelve
        // it does not look at.
        const contentBlock = await import('../src/content-block.js');
        const shared = [
            'canonicalContentBlockJson',
            'generateCustomId',
            'generateLegacyCustomId',
            'normalizeTokenText',
            'TRANSLATABLE_ATTRIBUTES',
            'NON_TRANSLATABLE_ELEMENTS',
            'PHRASE_MARKER_ATTR',
            'PHRASE_MARKER_ATTR_LEGACY',
            'PHRASE_MARKER_ATTRS',
            'CONTENT_BLOCK_MARKER_ATTR',
            'CONTENT_BLOCK_MARKER_ATTR_LEGACY',
            'CONTENT_BLOCK_MARKER_ATTRS',
            'RESOLVED_MARKER_ATTR',
            'RESOLVED_MARKER_ATTR_LEGACY',
            'RESOLVED_MARKER_ATTRS',
        ] as const;

        expect(shared).toHaveLength(15);
        for (const name of shared) {
            expect(
                (pure as unknown as Record<string, unknown>)[name],
                `/pure's ${name} must BE content-block's, not a copy of it`
            ).toBe((contentBlock as unknown as Record<string, unknown>)[name]);
        }
    });

    it('the C0 strip is the one the tokenizer runs, not a copy', async () => {
        // `normalizeTokenText` strips through it, so a /pure copy would let a
        // server's keys drift from the browser's the first time the set changed.
        const identity = await import('../src/identity.js');
        expect(pure.stripC0Controls).toBe(identity.stripC0Controls);
    });

    it('the moved placeholder rewriter is one object on all three surfaces', async () => {
        // `normalizeMarkupPlaceholders` moved from `interpolate.ts` to
        // `identity.ts` (it decides a stored key, so it belongs with the other
        // capture-boundary rule) and `interpolate.ts` re-exports it so its eight
        // importers did not move. That re-export is the compat claim, and a
        // re-export is only compatible while it is the SAME function — someone
        // "restoring" a local definition there would leave both surfaces
        // exporting something named right and drifting apart.
        const identity = await import('../src/identity.js');
        const interpolate = await import('../src/interpolate.js');
        expect(pure.normalizeMarkupPlaceholders).toBe(identity.normalizeMarkupPlaceholders);
        expect(interpolate.normalizeMarkupPlaceholders).toBe(identity.normalizeMarkupPlaceholders);
    });

    it('the rich-phrase encoder is the one the DOM path delegates to', async () => {
        const identity = await import('../src/identity.js');
        expect(pure.encodeRichPhrase).toBe(identity.encodeRichPhrase);
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
