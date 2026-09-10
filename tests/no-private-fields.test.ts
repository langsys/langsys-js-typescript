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
 * is erased at build time and has no such restriction — the core has **77** of
 * those (42 fields + 35 methods, counted across `src/` with
 * `grep -rhoE '(^|\s)private [A-Za-z_$][A-Za-z0-9_$]*\s*[:=;]'` and the same
 * with `[(<]`) and every one is fine. An earlier version of this comment said
 * 13, which is `langsys-app.ts` alone.
 *
 * Adopting a single `#private` field would therefore break every Proxy-based
 * binding, at runtime, in whichever method touched it. Nothing in the type
 * system or the build says so, which is why it is pinned here.
 *
 * THE BUILD DOES NOT KEEP `#`. At our `es2021` target esbuild LOWERS a private
 * field to `__privateAdd` / `__privateGet` over a WeakMap, so a literal scan of
 * `dist` finds nothing: measured, `grep -c '#secret' dist/index.mjs` is 0 after
 * building a reachable `#secret`. The hazard survives the lowering completely —
 * the lowered form still throws `TypeError: Cannot read from private field`
 * through a Proxy, verified by loading the built artifact — so a literal-only
 * dist scan reports a clean build of code that breaks every Proxy binding.
 * The dist half therefore looks for esbuild's lowering signature as well.
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

/**
 * Every TypeScript source extension, not just `.ts`. A `src/evasion.mts`
 * carrying `#x` and re-exported through `index.ts` typechecks, builds, and was
 * invisible to a `.ts`-only walk — so the invariant had a hole the width of a
 * file extension. `.tsx` is not reachable in this repo (TS6142 without `--jsx`)
 * and is included anyway, since the cost is one array entry.
 */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return sourceFiles(full);
        return SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext)) ? [full] : [];
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
        const offenders = sourceFiles(SRC)
            .map((file) => ({ file, found: findPrivateFields(readFileSync(file, 'utf8')) }))
            .filter((r) => r.found.length > 0)
            .map((r) => `${r.file.replace(process.cwd() + '/', '')}: ${r.found.join(', ')}`);

        expect(offenders).toEqual([]);
    });

    it.each(['dist/index.mjs', 'dist/index.js'])('holds in %s, which is what bindings proxy', (artifact) => {
        // The package build keeps dependencies external, so this is our code
        // only — a dependency's own #private fields are its business, since no
        // binding proxies them.
        //
        // A missing dist is a HARD FAILURE, not a skip. It used to `continue`
        // silently, and CI ran `npm test` before `npm run build` — so this
        // assertion was a permanent green no-op in the only place it was
        // automated. An invariant that cannot fail where it runs is not an
        // invariant.
        let built: string;
        try {
            built = readFileSync(join(process.cwd(), artifact), 'utf8');
        } catch {
            throw new Error(`${artifact} is missing — run \`npm run build\` before \`npm test\`. ` +
                `This check is not skippable: the built artifact is what bindings actually proxy.`);
        }

        // Literal `#name` survives only at es2022+. At our es2021 target esbuild
        // lowers it, so the lowering helpers are the signal that matters here.
        expect(findPrivateFields(built), `${artifact} must contain no literal #private fields`).toEqual([]);
        expect(
            [...built.matchAll(/__private(?:Add|Get|Set|Method|Wrapper|In)\b/g)].map((m) => m[0]),
            `${artifact} must contain no lowered #private fields — esbuild emits these helpers ` +
                `only when it downlevels a real one, and the lowered form still throws through a Proxy`
        ).toEqual([]);
    });
});
