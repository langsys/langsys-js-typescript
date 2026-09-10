import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INVARIANT — the core declares no ECMAScript `#private` fields.
 *
 * Vue and Solid forward core methods through a `Proxy` UNBOUND and assert
 * identity, so `proxy.method()` runs with `this` set to the proxy rather than
 * the instance. That is safe exactly while no method touches a `#private`
 * field: `#` access is keyed to the real instance, so reading one through a
 * proxy throws `TypeError: Cannot read private member`. TypeScript's `private`
 * is erased at build time and has no such restriction — the core has 13 of
 * those and they are fine.
 *
 * Adopting a single `#private` field would therefore break every Proxy-based
 * binding, at runtime, in whichever method touched it. Nothing in the type
 * system or the build says so, which is why it is pinned here.
 *
 * The scanner STRIPS comments, strings, template literals and regex literals
 * before looking, rather than trying to out-clever the false positives with an
 * anchored pattern. This repo's own source is full of `#`: CSS hex (`#fff`,
 * `#e0005a` in the logger), URL fragments (`#/pricing`, `#access_token=`), a
 * Svelte `{#each}` in a docstring, and a `/^#!?\/.+/` route regex. A naive
 * `/#\w+/` matches two CSS colours in `dist/index.mjs` alone — measured by the
 * React lane. Removing the places `#` is legal makes what remains meaningful by
 * construction.
 */

/** Remove everything where a `#` carries no language meaning. */
function stripNonCode(src: string): string {
    let out = '';
    let i = 0;
    // A `/` opens a regex only where a value may not appear; after a value it is
    // division. Tracking the previous significant character is the standard
    // approximation and is enough here.
    let prevSignificant = '';

    // A leading hashbang is not a private field.
    if (src.startsWith('#!')) {
        const nl = src.indexOf('\n');
        i = nl === -1 ? src.length : nl;
    }

    while (i < src.length) {
        const ch = src[i]!;
        const next = src[i + 1];

        if (ch === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (src[i] === quote) {
                    i++;
                    break;
                }
                // A template literal's `${…}` holds real code, so keep it.
                if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
                    let depth = 1;
                    i += 2;
                    const start = i;
                    while (i < src.length && depth > 0) {
                        if (src[i] === '{') depth++;
                        else if (src[i] === '}') depth--;
                        if (depth > 0) i++;
                    }
                    out += stripNonCode(src.slice(start, i));
                    i++;
                    continue;
                }
                i++;
            }
            out += ' ';
            continue;
        }
        if (ch === '/' && !'=+-*/%<>&|^!~?:,;([{'.includes(prevSignificant) && prevSignificant !== '') {
            // Division — fall through and emit it.
        } else if (ch === '/') {
            i++;
            while (i < src.length && src[i] !== '/') {
                if (src[i] === '\\') i++;
                else if (src[i] === '[') {
                    while (i < src.length && src[i] !== ']') i++;
                }
                i++;
            }
            i++;
            out += ' ';
            continue;
        }

        out += ch;
        if (!/\s/.test(ch)) prevSignificant = ch;
        i++;
    }
    return out;
}

/** Every `#private` declaration or access left once `#` can only mean one thing. */
function findPrivateFields(src: string): string[] {
    const code = stripNonCode(src);
    return [...code.matchAll(/#[A-Za-z_$][A-Za-z0-9_$]*/g)].map((m) => m[0]);
}

function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return tsFiles(full);
        return entry.endsWith('.ts') ? [full] : [];
    });
}

const SRC = join(process.cwd(), 'src');

describe('the scanner can actually find a #private field', () => {
    // If THIS fails, every assertion below is worthless — it would be reporting
    // "none found" from a scanner incapable of finding one.
    const CONTROL = `
        class Fixture {
            #secret = 1;
            static #count = 0;
            #hidden() { return 2; }
            read() { return this.#secret + Fixture.#count + this.#hidden(); }
        }
    `;

    it('catches a declaration and an access in a fixture', () => {
        const found = findPrivateFields(CONTROL);
        expect(found).toContain('#secret');
        expect(found).toContain('#count');
        expect(found).toContain('#hidden');
    });

    it('catches one inside a template literal expression', () => {
        expect(findPrivateFields('class A { #x = 1; t() { return `v=${this.#x}`; } }')).toContain('#x');
    });
});

describe('the scanner does not fire on the places # is legal', () => {
    // Each of these appears in this repo today. A pattern that flags them would
    // be turned off within a week, which costs the invariant.
    it.each([
        ['CSS hex in a string', `const S = 'background:#e0005a;color:#fff';`],
        ['a hash route', `const R = 'https://a.com/#/pricing';`],
        ['a bare fragment', `const F = '#section';`],
        ['an implicit-flow fragment', `const I = '#access_token=abc';`],
        ['a line comment', `// see {#each} in the Svelte binding`],
        ['a block comment', `/* #hero and #contact are anchors */`],
        ['a route regex', `const RE = /^#!?\\/.+/;`],
        ['a regex with a word', `const RE2 = /#section/;`],
        ['a private-looking string', `const P = 'this.#secret';`],
    ])('ignores %s', (_label, source) => {
        expect(findPrivateFields(source)).toEqual([]);
    });

    it('still finds a real field in a file that also contains all of those', () => {
        // The two halves together: stripping must not be so aggressive that it
        // swallows the thing being looked for.
        const mixed = `
            const S = 'background:#fff';   // {#each}
            const RE = /^#!?\\/.+/;
            class A { #real = 1; }
        `;
        expect(findPrivateFields(mixed)).toEqual(['#real']);
    });
});

describe('INVARIANT: the core declares no #private fields', () => {
    it('holds across every file in src/', () => {
        const offenders = tsFiles(SRC)
            .map((file) => ({ file, found: findPrivateFields(readFileSync(file, 'utf8')) }))
            .filter((r) => r.found.length > 0)
            .map((r) => `${r.file.replace(process.cwd() + '/', '')}: ${r.found.join(', ')}`);

        expect(offenders).toEqual([]);
    });

    it('holds in the built package, which is what bindings actually proxy', () => {
        // The package build keeps dependencies external, so this is our code
        // only — a dependency's own #private fields are its business, since no
        // binding proxies them. Skipped rather than failed when dist is absent,
        // because a fresh clone has not run the build yet.
        for (const artifact of ['dist/index.mjs', 'dist/index.js']) {
            let built: string;
            try {
                built = readFileSync(join(process.cwd(), artifact), 'utf8');
            } catch {
                continue;
            }
            expect(findPrivateFields(built), `${artifact} must declare no #private fields`).toEqual([]);
        }
    });
});
