import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The agent skill in `skill/` ships in the package, and an agent trusts every name in it. So it
 * names only what the built package has, against `dist/` rather than `src/`, since the build is
 * what an agent's project installs:
 *
 * - every name a code example imports from `langsys-js-typescript` or one of its subpaths is an
 *   export of that entry, a value or a type;
 * - every `LangsysApp.x` and `LangsysAppAPI.x` is a public member of the built singleton's class;
 * - every `scope.x`, `seed.x` and `tSignal.x`, in examples and inline code alike, is a public member
 *   of the type that receiver is;
 * - every SDK-shaped name in inline code (a call, or an identifier with a capital in it) is an
 *   export, or a member some other declaration in the build has. A name only a singleton has reads
 *   as an export when bare, so its file names it as `LangsysApp.x` at least once;
 * - the init options table lists exactly `iLangsysInitConfig`'s members;
 * - every subpath it names is in package.json `exports`, and its file is built.
 *
 * It also carries the shared Langsys skill preamble word for word (`skill/preamble.md`, this
 * package's copy of the template every Langsys SDK's skill opens with), states the version and
 * name package.json holds (the release script stamps the version as it bumps), links only files
 * that exist, and is in package.json `files`. The release script refuses the template's
 * unfilled `{{SLOT}}` markers; this suite doesn't, so a branch can hold a draft.
 *
 * Each check carries a planted defect it must report, so a checker that stopped seeing names
 * fails its control rather than reporting a clean skill.
 *
 * Not checked: option keys inside example objects, the types and defaults in the init table, which
 * entry an inline name comes from, and whether an anchor or an outside URL resolves.
 *
 * Reads dist/, so `npm run build` comes first, as for the other build-reading files. The release
 * script runs it after its own build.
 */

const ROOT = join(__dirname, '..');
const SKILL = join(ROOT, 'skill');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    files: string[];
    exports: Record<string, string | Record<string, string | Record<string, string>>>;
};

/**
 * Names in inline code that are not the package's, by kind, so a reader can see why each one
 * may appear: platform and runtime APIs, TypeScript's own types, and third-party libraries.
 */
const NOT_THE_PACKAGES = new Set([
    // platform and runtime
    'localStorage', 'AsyncLocalStorage', 'HTMLElement', 'Intl', 'navigator', 'document', 'window', 'fetch',
    // TypeScript
    'TemplateStringsArray',
    // third-party
    'MessageFormat',
]);

/** Source expressions the skill uses as examples of an app's own code: value-markers.md's naming table. */
const EXAMPLE_CODE = new Set(['userName', 'formatDate']);

/** Receivers that are the package's objects, by the declared type each one is, so `scope.run()` checks `run` on `RequestScope`. */
const SDK_RECEIVERS: Record<string, string> = { scope: 'RequestScope', seed: 'RequestSeed', tSignal: 'Signal' };

/** The classes the singletons are instances of, in the declaration files. */
const SINGLETON_CLASSES = { LangsysApp: 'LangsysAppClass', LangsysAppAPI: 'LangsysAppAPIClass' } as const;

/**
 * Whether a bare name in inline code is shaped like an SDK name: a call, a camelCase name with a
 * hump, a PascalCase name with two or more humps (`TFunction`), or an UPPER_SNAKE constant. A single
 * capitalized word (`Save`, `Errors`) or an initialism (`UI`) is a phrase, a category or a value,
 * the skill's example data.
 */
function sdkShaped(name: string, isCall: boolean): boolean {
    return isCall || /^[a-z][a-z0-9]*[A-Z]/.test(name) || /^[A-Z][a-z0-9]*[A-Z][a-z]/.test(name) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(name);
}

type Docs = Record<string, string>;

interface Facts {
    /** Exported names per entry, values and types: `langsys-js-typescript`, `langsys-js-typescript/pure`. */
    exports: Record<string, Set<string>>;
    /** Public member names declared in the build's declaration files, outside the singletons' classes. */
    members: Set<string>;
    /** Public members of the built `LangsysApp` and `LangsysAppAPI`, as their classes declare them. */
    singletons: Record<'LangsysApp' | 'LangsysAppAPI', Set<string>>;
    /** Public members of each declared class and interface, by name. */
    declared: Map<string, Set<string>>;
    /** `iLangsysInitConfig`'s members. */
    initOptions: Set<string>;
    /** package.json `exports` subpaths, with whether each import target is built. */
    subpaths: Map<string, boolean>;
    pkg: { name: string; version: string; files: string[] };
}

/** The names an `export { … }` list makes public, `X as Y` read as `Y`. */
function exportListNames(dts: string): string[] {
    const names: string[] = [];
    for (const m of dts.matchAll(/^export \{([^}]*)\}/gm)) {
        for (const spec of m[1]!.split(',')) {
            const s = spec.trim().replace(/^type\s+/, '');
            if (!s) continue;
            const alias = s.match(/\bas\s+([\w$]+)$/);
            names.push(alias ? alias[1]! : s);
        }
    }
    return names;
}

async function runtimeExports(file: string): Promise<string[]> {
    return Object.keys(await import(pathToFileURL(join(ROOT, 'dist', file)).href));
}

/** A member line at a declaration's own depth (four spaces in the built .d.ts), and whether it's private. */
const MEMBER_LINE = /^ {4}((?:(?:private|protected|public|readonly|static|abstract|get|set)\s+)*)([A-Za-z_$][\w$]*)\??\s*[:(<;]/gm;

/**
 * Each top-level class and interface in a declaration file, by name, with its public members, and
 * the file's text with those bodies cut out. A body is matched by its braces, so a member whose
 * type spans lines doesn't end it early.
 */
function declarations(dts: string): { bodies: Map<string, Set<string>>; rest: string } {
    const bodies = new Map<string, Set<string>>();
    let rest = '';
    let at = 0;
    for (const m of dts.matchAll(/^(?:export )?(?:declare )?(?:abstract )?(?:class|interface) ([A-Za-z_$][\w$]*)[^{\n]*\{$/gm)) {
        const open = m.index! + m[0].length - 1;
        if (open < at) continue;
        let depth = 0;
        let close = open;
        for (; close < dts.length; close++) {
            if (dts[close] === '{') depth++;
            else if (dts[close] === '}' && --depth === 0) break;
        }
        const names = bodies.get(m[1]!) ?? new Set<string>();
        for (const line of dts.slice(open + 1, close).matchAll(MEMBER_LINE)) {
            if (!/\b(private|protected)\b/.test(line[1]!)) names.add(line[2]!);
        }
        bodies.set(m[1]!, names);
        rest += dts.slice(at, m.index!);
        at = close + 1;
    }
    return { bodies, rest: rest + dts.slice(at) };
}

function importTarget(entry: unknown): string | undefined {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        return importTarget(e.import ?? e.default ?? e.require);
    }
    return undefined;
}

async function buildFacts(): Promise<Facts> {
    const dist = join(ROOT, 'dist');
    const dtsFiles = readdirSync(dist).filter((f) => f.endsWith('.d.ts'));
    const indexDts = readFileSync(join(dist, 'index.d.ts'), 'utf8');
    const pureDts = readFileSync(join(dist, 'pure.d.ts'), 'utf8');
    const members = new Set<string>();
    const declared = new Map<string, Set<string>>();
    const singletonClasses = new Set<string>(Object.values(SINGLETON_CLASSES));
    for (const f of dtsFiles) {
        const { bodies, rest } = declarations(readFileSync(join(dist, f), 'utf8'));
        for (const [name, names] of bodies) {
            declared.set(name, new Set([...(declared.get(name) ?? []), ...names]));
            if (!singletonClasses.has(name)) for (const n of names) members.add(n);
        }
        // Type literals outside any class or interface (an options object's `type X = { … }`).
        for (const line of rest.matchAll(MEMBER_LINE)) if (!/\b(private|protected)\b/.test(line[1]!)) members.add(line[2]!);
    }
    const initBlock = (indexDts.match(/interface iLangsysInitConfig \{([\s\S]*?)\n\}/) ?? [])[1] ?? '';
    const subpaths = new Map<string, boolean>();
    for (const [key, entry] of Object.entries(PKG.exports)) {
        const target = importTarget(entry);
        subpaths.set(key, !!target && existsSync(join(ROOT, target)));
    }
    return {
        exports: {
            'langsys-js-typescript': new Set([...(await runtimeExports('index.mjs')), ...exportListNames(indexDts)]),
            'langsys-js-typescript/pure': new Set([...(await runtimeExports('pure.mjs')), ...exportListNames(pureDts)]),
        },
        members,
        singletons: {
            LangsysApp: declared.get(SINGLETON_CLASSES.LangsysApp) ?? new Set(),
            LangsysAppAPI: declared.get(SINGLETON_CLASSES.LangsysAppAPI) ?? new Set(),
        },
        declared,
        initOptions: new Set([...initBlock.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!)),
        subpaths,
        pkg: { name: PKG.name, version: PKG.version, files: PKG.files },
    };
}

function readDocs(): Docs {
    const docs: Docs = {};
    for (const f of readdirSync(SKILL).filter((n) => n.endsWith('.md'))) docs[f] = readFileSync(join(SKILL, f), 'utf8');
    return docs;
}

const FENCE = /```[a-z]*\n([\s\S]*?)```/g;
const PREAMBLE = /<!-- langsys-skill-preamble:start -->\n([\s\S]*?)\n<!-- langsys-skill-preamble:end -->/;

/** Every problem the skill has against the build; empty when it names only what exists. */
function problems(docs: Docs, facts: Facts): string[] {
    const found: string[] = [];
    const allExports = new Set([...facts.exports['langsys-js-typescript']!, ...facts.exports['langsys-js-typescript/pure']!]);
    const known = (name: string) => allExports.has(name) || facts.members.has(name) || NOT_THE_PACKAGES.has(name);
    const singletonOf = (name: string) => (Object.keys(facts.singletons) as Array<'LangsysApp' | 'LangsysAppAPI'>).find((s) => facts.singletons[s].has(name));
    const receiverMember = (file: string, receiver: string, name: string, where: string) => {
        const type = SDK_RECEIVERS[receiver]!;
        if (!facts.declared.get(type)?.has(name)) found.push(`${file}: ${where} \`${receiver}.${name}\`, which ${type} does not have`);
    };

    for (const [file, text] of Object.entries(docs)) {
        const code = [...text.matchAll(FENCE)].map((m) => m[1]!).join('\n');
        const prose = text.replace(FENCE, '');

        // 1. What the examples import.
        for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](langsys-js-typescript(?:\/[\w-]+)?)['"]/g)) {
            const entry = facts.exports[m[2]!];
            for (const spec of m[1]!.split(',')) {
                const name = spec.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!;
                if (!name) continue;
                if (!entry) found.push(`${file}: imports ${name} from ${m[2]}, which is not an entry the gate knows`);
                else if (!entry.has(name)) found.push(`${file}: imports ${name}, which ${m[2]} does not export`);
            }
        }

        // 2. Members of the singletons, anywhere in the file, and of the receivers in examples.
        for (const m of text.matchAll(/\b(LangsysAppAPI|LangsysApp)\.([A-Za-z_$][\w$]*)/g)) {
            if (!facts.singletons[m[1] as 'LangsysApp']!.has(m[2]!)) found.push(`${file}: ${m[1]}.${m[2]} is not a public member of the built ${m[1]}`);
        }
        for (const m of code.matchAll(/(?<![\w$.])(\w+)\.([A-Za-z_$][\w$]*)/g)) {
            if (m[1]! in SDK_RECEIVERS) receiverMember(file, m[1]!, m[2]!, 'an example uses');
        }

        // 3. SDK-shaped names in inline code.
        for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
            const span = m[1]!;
            const shape = span.match(/^((?:[A-Za-z_$][\w$]*\.)*)([A-Za-z_$][\w$]*)(\([^)]*\))?$/);
            if (!shape) continue;
            const receiver = shape[1]!.slice(0, -1);
            const name = shape[2]!;
            if (receiver) {
                // LangsysApp and LangsysAppAPI are rule 2's; any other receiver is the app's own object.
                if (!receiver.includes('.') && receiver in SDK_RECEIVERS) receiverMember(file, receiver, name, 'names');
                continue;
            }
            if (!sdkShaped(name, !!shape[3]) || EXAMPLE_CODE.has(name)) continue;
            if (known(name)) continue;
            // A singleton's member may be named bare once its file has written it in full.
            const singleton = singletonOf(name);
            if (!singleton) found.push(`${file}: \`${span}\` names ${name}, which the build neither exports nor declares`);
            else if (!text.includes(`${singleton}.${name}`)) found.push(`${file}: \`${span}\` names ${name}, which only ${singleton} has: write ${singleton}.${name} at least once`);
        }

        // 4. Subpaths.
        for (const m of text.matchAll(/langsys-js-typescript\/([\w-]+)/g)) {
            if (m[1] === 'skill' || m[1] === 'dist') continue;
            const built = facts.subpaths.get(`./${m[1]}`);
            if (built === undefined) found.push(`${file}: langsys-js-typescript/${m[1]} is not in package.json exports`);
            else if (!built) found.push(`${file}: langsys-js-typescript/${m[1]} is exported but its file is not built`);
        }

        // 5. Links between the skill's files, each written `./file.md`.
        for (const m of text.matchAll(/\]\(\.\/([\w.-]+\.md)(?:#[\w-]*)?\)/g)) {
            if (!(m[1]! in docs)) found.push(`${file}: links ./${m[1]}, which is not in skill/`);
        }
        for (const m of text.matchAll(/\]\((?!\.\/|https?:|#)([^)\s]+)\)/g)) found.push(`${file}: links ${m[1]}, which is not a ./ link to a skill file`);
    }

    // 6. The init options table lists exactly iLangsysInitConfig's members.
    const init = docs['init-config.md'] ?? '';
    const table = (init.match(/## Fields[^\n]*\n([\s\S]*?)\n## /) ?? [])[1] ?? '';
    const listed = new Set([...table.matchAll(/^\| `([A-Za-z_$][\w$]*)` \|/gm)].map((m) => m[1]!));
    for (const name of listed) if (!facts.initOptions.has(name)) found.push(`init-config.md: lists option ${name}, which iLangsysInitConfig does not have`);
    for (const name of facts.initOptions) if (!listed.has(name)) found.push(`init-config.md: does not list option ${name}`);

    // 7. Name and version, as package.json holds them.
    const skill = docs['SKILL.md'] ?? '';
    const front = (skill.match(/^---\n([\s\S]*?)\n---\n/) ?? [])[1] ?? '';
    if (!/^name: langsys-typescript$/m.test(front)) found.push('SKILL.md: frontmatter name is not langsys-typescript');
    if (!new RegExp(`^  package: ${facts.pkg.name}$`, 'm').test(front)) found.push(`SKILL.md: frontmatter package is not ${facts.pkg.name}`);
    const version = (front.match(/^ {2}version: (\S+)$/m) ?? [])[1];
    if (version !== facts.pkg.version) found.push(`SKILL.md: frontmatter version is ${version}, package.json ${facts.pkg.version}`);

    // 8. The preamble, word for word.
    const span = (skill.match(PREAMBLE) ?? [])[1];
    const template = (docs['preamble.md'] ?? '').trim();
    if (span === undefined) found.push('SKILL.md: no langsys-skill-preamble span');
    else if (span.trim() !== template) found.push('SKILL.md: the preamble span differs from preamble.md');
    if (!skill.slice(skill.indexOf('\n---\n') + 5).trimStart().replace(/^# [^\n]*\n+/, '').startsWith('<!-- langsys-skill-preamble:start -->')) {
        found.push('SKILL.md: the preamble is not the first thing after the title');
    }

    // 9. Every topic file is reachable from SKILL.md, and the folder ships.
    for (const file of Object.keys(docs)) {
        if (file === 'SKILL.md' || file === 'preamble.md') continue;
        if (!skill.includes(`(./${file})`)) found.push(`SKILL.md: does not link ${file}`);
    }
    if (!facts.pkg.files.includes('skill')) found.push('package.json: files does not include skill');

    return found;
}

describe('the agent skill names only what the built package has', async () => {
    const facts = await buildFacts();
    const docs = readDocs();

    it('has no problem against the build, its preamble and package.json', () => {
        expect(problems(docs, facts)).toEqual([]);
    });

    it('reads every file it should: the skill, its topics, and the template', () => {
        expect(Object.keys(docs)).toContain('SKILL.md');
        expect(Object.keys(docs)).toContain('preamble.md');
        expect(Object.keys(docs).length).toBeGreaterThan(5);
        expect(facts.initOptions.size, 'iLangsysInitConfig read from the build').toBeGreaterThan(10);
        expect(facts.exports['langsys-js-typescript']!.has('TFunction'), 'type exports read').toBe(true);
        expect(facts.singletons.LangsysApp.has('init'), 'singleton members read').toBe(true);
    });

    const planted: Array<[string, (d: Docs) => Docs, string]> = [
        ['an import the entry does not export', (d) => ({ ...d, 'primitives.md': d['primitives.md'] + "\n```ts\nimport { t, renderEverything } from 'langsys-js-typescript';\n```\n" }), 'imports renderEverything'],
        ['an import /pure does not export', (d) => ({ ...d, 'primitives.md': d['primitives.md'] + "\n```ts\nimport { tokenizeElement } from 'langsys-js-typescript/pure';\n```\n" }), 'imports tokenizeElement, which langsys-js-typescript/pure does not export'],
        ['a LangsysApp member that does not exist', (d) => ({ ...d, 'catalog.md': d['catalog.md'] + '\n`LangsysApp.reloadEverything()`\n' }), 'LangsysApp.reloadEverything'],
        ['an inline call the build does not have', (d) => ({ ...d, 'writing.md': d['writing.md'] + '\nCall `flushEverything()` after.\n' }), 'names flushEverything'],
        ['an inline type the build does not have', (d) => ({ ...d, 'writing.md': d['writing.md'] + '\nIt resolves a `RegistrationOutcome`.\n' }), 'names RegistrationOutcome'],
        ['an inline constant the build does not have', (d) => ({ ...d, 'primitives.md': d['primitives.md'] + '\nSee `PHRASE_MARKER_NAME`.\n' }), 'names PHRASE_MARKER_NAME'],
        ['a request-scope member that does not exist', (d) => ({ ...d, 'server-rendering.md': d['server-rendering.md'] + '\nThen `scope.flushAll()`.\n' }), 'names `scope.flushAll`, which RequestScope does not have'],
        ['a member another class has but the receiver does not', (d) => ({ ...d, 'server-rendering.md': d['server-rendering.md'] + '\nThen `scope.subscribe(run)`.\n' }), 'names `scope.subscribe`, which RequestScope does not have'],
        ['a request-scope member in an example that does not exist', (d) => ({ ...d, 'server-rendering.md': d['server-rendering.md'] + '\n```ts\nawait scope.flushAll();\n```\n' }), 'an example uses `scope.flushAll`'],
        ['a type-only import in double quotes the entry does not export', (d) => ({ ...d, 'writing.md': d['writing.md'] + '\n```ts\nimport type { RegistrationOutcome } from "langsys-js-typescript";\n```\n' }), 'imports RegistrationOutcome'],
        ['an import from an entry the gate does not know', (d) => ({ ...d, 'catalog.md': d['catalog.md'] + "\n```ts\nimport { t } from 'langsys-js-typescript/server';\n```\n" }), 'not an entry the gate knows'],
        ['a private LangsysApp member', (d) => ({ ...d, 'catalog.md': d['catalog.md'] + '\n`LangsysApp.applyAuthorization()`\n' }), 'LangsysApp.applyAuthorization is not a public member'],
        ['a LangsysApp method written as if it were an export', (d) => ({ ...d, 'value-markers.md': d['value-markers.md'] + '\nCall `detectPreferredLocale(header)`.\n' }), 'write LangsysApp.detectPreferredLocale at least once'],
        ['an init option that does not exist', (d) => ({ ...d, 'init-config.md': d['init-config.md'].replace('| `debug` |', '| `cacheTtl` | `number` | none | x |\n| `debug` |') }), 'lists option cacheTtl'],
        ['an init option left out', (d) => ({ ...d, 'init-config.md': d['init-config.md'].replace(/^\| `messagesCategory` \|.*\n/m, '') }), 'does not list option messagesCategory'],
        ['a subpath that does not exist', (d) => ({ ...d, 'server-rendering.md': d['server-rendering.md'] + '\nImport `langsys-js-typescript/server`.\n' }), 'langsys-js-typescript/server is not in package.json exports'],
        ['a link to a missing file', (d) => ({ ...d, 'catalog.md': d['catalog.md'] + '\n[gone](./gone.md)\n' }), 'links ./gone.md'],
        ['a link not written ./file.md', (d) => ({ ...d, 'catalog.md': d['catalog.md'] + '\n[topics](primitives.md)\n' }), 'links primitives.md, which is not a ./ link'],
        ['a frontmatter name that is not the skill\'s', (d) => ({ ...d, 'SKILL.md': d['SKILL.md'].replace(/^name: .*$/m, 'name: langsys-ts') }), 'frontmatter name is not langsys-typescript'],
        ['a frontmatter package that is not package.json\'s', (d) => ({ ...d, 'SKILL.md': d['SKILL.md'].replace(/^ {2}package: .*$/m, '  package: langsys-js') }), 'frontmatter package is not langsys-js-typescript'],
        ['a version package.json does not hold', (d) => ({ ...d, 'SKILL.md': d['SKILL.md'].replace(/^ {2}version: .*$/m, '  version: 9.9.9') }), 'frontmatter version is 9.9.9'],
        ['a preamble that drifted from the template', (d) => ({ ...d, 'SKILL.md': d['SKILL.md'].replace('never skip a step', 'skip what you like') }), 'the preamble span differs'],
        ['a preamble that is not the first thing after the title', (d) => ({ ...d, 'SKILL.md': d['SKILL.md'].replace('<!-- langsys-skill-preamble:start -->', 'An opening line.\n\n<!-- langsys-skill-preamble:start -->') }), 'the preamble is not the first thing after the title'],
        ['a topic file SKILL.md does not link', (d) => ({ ...d, 'orphan.md': '# Orphan\n' }), 'does not link orphan.md'],
    ];

    it.each(planted)('reports %s', (_what, plant, expected) => {
        expect(problems(plant(docs), facts).join('\n')).toContain(expected);
    });

    it('reports a package.json that does not ship skill/', () => {
        expect(problems(docs, { ...facts, pkg: { ...facts.pkg, files: ['dist'] } })).toContain('package.json: files does not include skill');
    });

    it('reports a subpath that is exported but not built', () => {
        const subpaths = new Map(facts.subpaths).set('./pure', false);
        expect(problems(docs, { ...facts, subpaths }).join('\n')).toContain('langsys-js-typescript/pure is exported but its file is not built');
    });
});
