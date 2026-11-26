// ICU-7: every surface this package ships shows phrases flat (`You have {count} new messages`)
// and never writes a `plural`, `select` or `selectordinal` into a phrase. No network.
//
// The surfaces are every file the package ships that a developer or an agent can read, as
// `npm pack` lists them: the README, the skill, the type declarations an editor shows with their
// doc comments, and the built code. Beside them, every other file in the repository except the
// source, the tests and the root files named below with their reasons: the guides, the example,
// the scripts and any demo added later. A file of a kind it neither reads nor names fails it, so a
// guide in a new format is read or named, never skipped. A construct is allowed
// only in a passage named in EXEMPT below, which says which of the three roles ICU has in
// documentation it serves. A new ICU example fails here until someone decides it belongs in one of
// them and names it. CHANGELOG.md records what earlier releases did and is outside the rule.
//
// The shipped files are read from `dist/`, so `npm run build` precedes this test, as it does
// `no-private-fields`; a missing build fails it rather than skipping the declarations.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICU_CONSTRUCT, scanSurface, shippedFiles, surfaceName, type ExemptPassage } from './helpers/icu-docs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Each built bundle holds MIG-4's converter, whose code writes the plural it registers. */
const BUNDLES = ['dist/index.js', 'dist/index.mjs', 'dist/pure.js', 'dist/pure.mjs', 'dist/langsys.browser.global.js', 'dist/langsys.browser.mjs'];

/** The three roles ICU has in documentation, as named passages. */
const EXEMPT: readonly ExemptPassage[] = [
    // Role: what the catalog returns. Each says what a translation holds, for the reader who renders
    // one or wonders what `name_gender` is; the phrase the developer writes stays flat.
    {
        file: 'README.md',
        role: 'catalog',
        text: "The translations Langsys sends hold those forms as ICU MessageFormat (`{count, plural, one {# item} other {# items}}`, `{name_gender, select, …}`), which `t()` renders with the active locale's CLDR plural rules (Arabic's six categories, Russian's four, etc.), alongside plain `{name}` slots.",
        mark: 'The translations Langsys sends',
    },
    {
        file: 'README.md',
        role: 'catalog',
        text: 'In a language with grammatical gender, Langsys can turn a plain `{name}` into `{name_gender, select, …}` in the translation.',
        mark: 'in the translation',
    },
    {
        file: 'skill/interpolation.md',
        role: 'catalog',
        text: 'In a language with grammatical gender, Langsys can turn `{name}` into `{name_gender, select, …}` in the translation.',
        mark: 'in the translation',
    },
    // The doc comments an editor shows from the type declarations: what the `_gender` companions,
    // `isICU`, `findUnusedParamKeys` and `interpolate` read in a translation.
    {
        file: 'dist/pure-[hash].d.ts',
        role: 'catalog',
        text: 'Langsys promotes a plain\n * `{username}` to `{username_gender, select, …}` in gendered target locales, so the\n * argument exists in the translation but never in the phrase you wrote.',
        mark: 'Langsys promotes',
    },
    {
        file: 'dist/pure-[hash].d.ts',
        role: 'catalog',
        text: "Matches a translation's `{var, plural, …}`, `{var, select, …}`, `{var, selectordinal, …}`,\n *     `{var, number, …}`, `{var, date, …}`, `{var, time, …}`.",
        mark: "a translation's",
    },
    {
        file: 'dist/pure-[hash].d.ts',
        role: 'catalog',
        text: 'Langsys\n * promotes a plain `{name}` to `{name_gender, select, …}` in gendered target\n * locales, so an app passes the gender beside the value (`GenderParamsFor` types\n * it), and the source text a caller checks never names it.',
        mark: 'Langsys',
    },
    {
        file: 'dist/pure-[hash].d.ts',
        role: 'catalog',
        text: "ICU MessageFormat (target string contains `{var, plural|select|…, …}`):\n *     parsed and formatted via `intl-messageformat`, which knows every\n *     target locale's plural rules (Arabic's 6 categories, Russian's 4,\n *     etc.) and gender-select branches.",
        mark: 'target string',
    },
    // Role: what MIG-4 converts a legacy plural file into, which the SDK registers, not the developer.
    {
        file: 'README.md',
        role: 'mig-4',
        text: '`vue-i18n`: `car | cars` becomes `{count, plural, =1 {car} other {cars}}`, and three forms add `=0`.',
        mark: 'becomes',
    },
    {
        file: 'skill/migration.md',
        role: 'mig-4',
        text: '`vue-i18n`: `car | cars` becomes `{count, plural, =1 {car} other {cars}}`, and three forms add `=0`.',
        mark: 'becomes',
    },
    // The converter's own code, in every bundle: the plural it builds from a file's forms.
    ...BUNDLES.map((file): ExemptPassage => ({ file, role: 'mig-4', text: '`{count, plural, ${', mark: 'recognised' })),
    // Role: a counter-example, marked wrong beside the flat phrase that replaces it.
    {
        file: 'skill/invariants.md',
        role: 'counter-example',
        text: "t('{count, plural, one {# new message} other {# new messages}}', 'Inbox', { count });",
        mark: '❌',
        flatBeside: "t('You have {count} new messages'",
    },
    {
        // The Quick reference's Don't column, with the flat phrase in the Do column of the same row.
        file: 'skill/invariants.md',
        role: 'counter-example',
        text: '`{count, plural, …}` written by hand',
        mark: 'written by hand',
        flatBeside: "t('You have {count} new messages'",
    },
];

if (!existsSync(join(ROOT, 'dist'))) throw new Error('dist/ is missing: run `npm run build` before this test, which reads the shipped files');

/** Every file the package ships, as `npm pack` lists them. */
const SHIPPED = shippedFiles(ROOT);

/** The shipped files a developer or an agent reads, which the rule covers. */
const SHIPPED_READ = /^(README\.md|package\.json|skill\/.+\.md|dist\/[^/]+\.(?:d\.ts|d\.mts|js|mjs))$/;

/** Shipped files outside the rule, each kind for its reason. A new kind of shipped file must be read or named here. */
const SHIPPED_OUTSIDE: ReadonlyArray<readonly [RegExp, string]> = [
    [/^CHANGELOG\.md$/, 'a changelog records what earlier releases did'],
    [/^LICENSE$/, 'the licence'],
    [/^dist\/[^/]+\.map$/, "a source map, which carries src/ as written for a debugger to show beside the build; the doc comments of what the package exports ship again in the declarations, which are read"],
];

/** The kinds of file it reads in the repository: every text format a guide, an example, a demo or a script is written in. */
const TEXT = /\.(md|mdx|markdown|txt|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|html|htm|vue|svelte|astro|css|yml|yaml|sh)$/;

/** Files in the repository it doesn't read, each kind for its reason. Any other file it doesn't read fails it, so a new kind is read or named here. */
const UNREAD_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
    [/(^|\/)LICENSE$/, 'the licence'],
    [/(^|\/)\.gitignore$/, "git's list of files it ignores"],
    [/(^|\/)\.DS_Store$/, "Finder's folder metadata, which git ignores"],
];

/** Directories at the root outside the rule, each for its reason. Every other directory is read, a new example or demo included. */
const OUTSIDE_DIRS = new Map<string, string>([
    ['src', "the code; the doc comments of what it exports ship in the declarations and the bundles, which are read, and the rest are its maintainers' notes"],
    ['tests', 'tests are outside the rule; their fixtures and planted cases hold ICU on purpose'],
    ['dist', 'the build, read file by file as the package ships it'],
    ['node_modules', 'dependencies'],
    ['.git', "git's own store"],
    ['coverage', 'a coverage report, generated'],
]);

/** Root files outside the rule, each for its reason. A new root document is read unless it is named here. */
const OUTSIDE = new Map<string, string>([
    ['CHANGELOG.md', 'a changelog records what earlier releases did'],
    ['CONFORMANCE.md', 'the grading of this package against the spec, written for its maintainers, not shipped to developers'],
    ['CLAUDE.md', "guidance for the maintainers' coding agent, not shipped to developers"],
    ['package-lock.json', 'the dependency lock, generated'],
]);

/** Every file under `root` but the directories and root files named outside the rule. */
function walk(root: string, dir = ''): string[] {
    return readdirSync(join(root, dir)).flatMap((name) => {
        const path = dir === '' ? name : `${dir}/${name}`;
        if (dir === '' ? OUTSIDE_DIRS.has(name) || OUTSIDE.has(name) : name === 'node_modules') return [];
        return statSync(join(root, path)).isDirectory() ? walk(root, path) : [path];
    });
}

/** The walked files it reads, and those it neither reads nor names a reason for. */
function placeFiles(paths: readonly string[]): { read: string[]; unplaced: string[] } {
    return {
        read: paths.filter((p) => TEXT.test(p)),
        unplaced: paths.filter((p) => !TEXT.test(p) && !UNREAD_KINDS.some(([kind]) => kind.test(p))),
    };
}

const REPOSITORY = placeFiles(walk(ROOT));

const SURFACES = [...new Set([...SHIPPED.filter((p) => SHIPPED_READ.test(p)), ...REPOSITORY.read])];

const scanFile = (path: string) => scanSurface(surfaceName(path), readFileSync(join(ROOT, path), 'utf8'), EXEMPT);

describe('ICU-7: documentation shows phrases flat', () => {
    it('reads the README, the skill, the shipped declarations and bundles, the guides and the example', () => {
        for (const expected of [
            'README.md',
            'TESTING.md',
            'ROADMAP.md',
            'package.json',
            'skill/SKILL.md',
            'skill/interpolation.md',
            'skill/invariants.md',
            'skill/migration.md',
            'dist/index.d.ts',
            'dist/index.d.mts',
            'dist/pure.d.ts',
            ...BUNDLES,
            'example/index.html',
            '_dev_/PUBLISHING.md',
            '_dev_/publish.sh',
            '.github/workflows/ci.yml',
            'contract-fixture/README.md',
            'contract-fixture/forwarder.mjs',
        ]) {
            expect(SURFACES).toContain(expected);
        }
        expect(SURFACES.filter((p) => surfaceName(p) === 'dist/pure-[hash].d.ts')).toHaveLength(2);
        for (const name of OUTSIDE.keys()) expect(SURFACES).not.toContain(name);
        for (const dir of OUTSIDE_DIRS.keys()) expect(SURFACES.filter((p) => p.startsWith(`${dir}/`) && !SHIPPED.includes(p))).toEqual([]);
    });

    it('reads every shipped file a reader reads, and names a reason for each one it leaves out', () => {
        const unplaced = SHIPPED.filter((p) => SHIPPED_READ.test(p) === SHIPPED_OUTSIDE.some(([pattern]) => pattern.test(p)));
        expect(unplaced).toEqual([]);
        expect(SHIPPED).toContain('skill/SKILL.md');
        expect(SHIPPED).toContain('CHANGELOG.md');
        expect(SHIPPED.filter((p) => SHIPPED_READ.test(p)).length).toBeGreaterThan(20);
    });

    it('reads every other file in the repository, or names its kind with a reason', () => {
        expect(REPOSITORY.unplaced).toEqual([]);
        const dir = mkdtempSync(join(tmpdir(), 'icu7-walk-'));
        try {
            for (const path of ['LICENSE', 'demo/.DS_Store', 'demo/notes.txt', 'demo/guide.markdown', 'demo/guide.adoc', 'demo/node_modules/x/index.js']) {
                mkdirSync(dirname(join(dir, path)), { recursive: true });
                writeFileSync(join(dir, path), '');
            }
            const placed = placeFiles(walk(dir));
            expect(placed.read.sort()).toEqual(['demo/guide.markdown', 'demo/notes.txt']);
            expect(placed.unplaced).toEqual(['demo/guide.adoc']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names every declaration file it reads as an entry or as a chunk whose hash it replaces', () => {
        const declarations = SURFACES.filter((p) => /\.d\.m?ts$/.test(p)).map(surfaceName);
        expect([...new Set(declarations)].sort()).toEqual(['dist/index.d.ts', 'dist/pure-[hash].d.ts', 'dist/pure.d.ts']);
    });

    it('writes no plural, select or selectordinal into a phrase, outside the named exempt passages', () => {
        const findings = SURFACES.flatMap(scanFile);
        expect(findings.map((f) => `${f.file}:${f.line} ${f.problem}`)).toEqual([]);
    });

    it('has every exempt passage in a surface it reads', () => {
        const names = SURFACES.map(surfaceName);
        for (const passage of EXEMPT) expect(names).toContain(passage.file);
    });
});

describe('ICU-7: the check fails on what it exists to catch', () => {
    const flat = ['`You have {count} new messages`', "t('You have {count} new messages', 'Inbox', { count });"].join('\n');
    const planted = "t('{count, plural, one {# item} other {# items}}', 'Cart', { count });";

    it('passes flat phrases', () => {
        expect(scanSurface('x.md', flat, [])).toEqual([]);
    });

    it.each([
        ['a t() argument', planted],
        ['a t() argument with no spaces', "t('{n,plural,one{# item}other{# items}}', 'Cart', { n });"],
        ['a numbered argument', "t('{0, plural, one {# item} other {# items}}', 'Cart', [count]);"],
        ['an argument named in another script', "t('{número, plural, one {# artículo} other {# artículos}}', 'Cart', { número });"],
        ['<Translate> content', '<Translate category="Cart">{count, plural, one {# item} other {# items}}</Translate>'],
        ['a template tag', 'tt`{gender, select, female {She} other {They}} replied`'],
        ['a phrase in prose', 'Write `{place, selectordinal, one {#st} two {#nd} other {#th}}` and it works.'],
        ['a select', "t('{who_gender, select, male {He} other {They}} left', 'UI', { who_gender })"],
        ['an `=0` branch', "export const msg = t('{count, plural, =0 {None} other {# left}}', 'Demo', { count });"],
        ['a doc comment example', " * @example\n *   t('{count, plural, one {# file} other {# files}}', 'Files', { count })"],
        ['a construct a doc comment wraps', " * Write `{count,\n * plural, one {# file} other {# files}}` for the count."],
        ['a construct a blockquote wraps', '> Write `{count,\n> plural, one {# file} other {# files}}` for the count.'],
        ['a construct a line comment wraps', '// t(`{count,\n//   plural, one {# file} other {# files}}`)'],
        ['an argument with an offset', "t('{count, plural, offset:1 one {You and one other} other {You and # others}}', 'Feed', { count });"],
        ['a construct elided in prose', 'Write `{count, plural, …}` and Langsys fills it in.'],
        ['a construct elided with three dots', 'Write `{count, plural, ...}` and Langsys fills it in.'],
        ['keywords written as alternatives', 'Write `{var, plural|select, …}` in the phrase.'],
    ])('fails on %s', (_name, text) => {
        const findings = scanSurface('example/index.html', text, []);
        expect(findings).toHaveLength(1);
        expect(findings[0].problem).toContain('ICU construct in a phrase');
    });

    it.each([
        ['README.md', 'README.md'],
        ['skill/interpolation.md', 'skill/interpolation.md'],
        ['the skill quick reference', 'skill/invariants.md'],
        ['the example', 'example/index.html'],
    ])('fails an ICU example planted in %s, with the real exempt passages in force', (_name, path) => {
        const real = readFileSync(join(ROOT, path), 'utf8');
        expect(scanFile(path)).toEqual([]);
        const findings = scanSurface(surfaceName(path), `${real}\n\n\`\`\`ts\n${planted}\n\`\`\`\n`, EXEMPT);
        expect(findings.map((f) => f.problem)).toEqual([expect.stringContaining('ICU construct in a phrase')]);
    });

    it.each([
        ['the declarations', (p: string) => p.endsWith('.d.ts') && surfaceName(p) === 'dist/pure-[hash].d.ts'],
        ['a bundle', (p: string) => p === 'dist/index.mjs'],
    ])('fails an ICU example planted in a doc comment of %s', (_name, pick) => {
        const path = SURFACES.find(pick);
        expect(path).toBeDefined();
        const real = readFileSync(join(ROOT, path as string), 'utf8');
        expect(scanFile(path as string)).toEqual([]);
        const comment = `/**\n * @example\n *   ${planted}\n */\n`;
        const findings = scanSurface(surfaceName(path as string), `${real}\n${comment}`, EXEMPT);
        expect(findings.map((f) => f.problem)).toEqual([expect.stringContaining('ICU construct in a phrase')]);
    });

    it('fails a catalog passage reworded to say the developer writes the construct', () => {
        const real = readFileSync(join(ROOT, 'README.md'), 'utf8');
        const reworded = real.replace('Langsys can turn a plain `{name}` into', 'You can turn a plain `{name}` into');
        expect(reworded).not.toBe(real);
        expect(scanSurface('README.md', reworded, EXEMPT).map((f) => f.problem)).toEqual([
            expect.stringContaining('not found'),
            expect.stringContaining('ICU construct in a phrase'),
        ]);
    });

    it('ignores the words plural and select where no argument uses them', () => {
        expect(scanSurface('x.md', '`<select>` picks a locale; pluralization needs the count and its noun in one phrase; a {select} placeholder, `{n}` selected', [])).toEqual([]);
        expect(scanSurface('x.md', 'Hello {name}, select a plan; {count} plural forms', [])).toEqual([]);
        expect(ICU_CONSTRUCT.flags).toContain('g');
    });

    it.each([
        ['object shorthand', '({ value, select }) => select(value)'],
        ['a destructured prop', 'export function LocalePicker({ locales, select }) {'],
        ['a destructuring with more names after it', 'const { value, select, other } = props;'],
        ['a destructuring prettier wraps', 'const {\n  value,\n  select,\n} = props;'],
        ['a property named plural', 'return { text, plural: true };'],
        ['a Svelte each block', '{#each options as {name, select}}'],
        ['a CSS selector list', '@media (max-width: 40em) {\n  input, select {\n    font: inherit;\n  }\n}'],
        ['minified code', 'function f({a,select:b}){return{a,select,b:{c:1}}}'],
    ])('passes code that names a select or a plural: %s', (_name, code) => {
        expect(scanSurface('example/App.tsx', code, [])).toEqual([]);
    });

    it('quotes the text around a construct, not its whole line, which in a minified bundle is the whole bundle', () => {
        const findings = scanSurface('dist/langsys.browser.mjs', `${'a;'.repeat(40000)}${planted}${'b;'.repeat(40000)}`, []);
        expect(findings).toHaveLength(1);
        expect(findings[0].problem).toContain('{count, plural, one {# item}');
        expect(findings[0].problem.length).toBeLessThan(300);
    });

    const counterExample: ExemptPassage = {
        file: 'x.md',
        role: 'counter-example',
        text: "t('{count, plural, one {#} other {#}}', 'A', { count });",
        mark: '❌',
        flatBeside: "t('You have {count} new messages'",
    };
    const marked = ["t('You have {count} new messages', 'A', { count });  // ✅", "t('{count, plural, one {#} other {#}}', 'A', { count });  // ❌ ICU written by hand"].join('\n');

    it('allows a counter-example marked wrong beside its flat replacement', () => {
        expect(scanSurface('x.md', marked, [counterExample])).toEqual([]);
    });

    it('fails an exempt passage edited to lose its marking', () => {
        const findings = scanSurface('x.md', marked.replace('❌', ''), [counterExample]);
        expect(findings.map((f) => f.problem)).toEqual([expect.stringContaining('lost its marking')]);
    });

    it('fails a counter-example whose flat replacement is gone', () => {
        const findings = scanSurface('x.md', marked.split('\n')[1], [counterExample]);
        expect(findings.map((f) => f.problem)).toEqual([expect.stringContaining('no flat replacement')]);
    });

    it("fails the skill's counter-example once the line beside it keeps its ✅ but no longer holds the phrase", () => {
        const real = readFileSync(join(ROOT, 'skill/invariants.md'), 'utf8');
        const edited = real.replace(/^t\('You have \{count\} new messages', 'Inbox', \{ count \}\);\s+\/\/ ✅.*$/m, '// ✅ see the README for the phrase to write');
        expect(edited).not.toBe(real);
        expect(scanSurface('skill/invariants.md', edited, EXEMPT).map((f) => f.problem)).toEqual([expect.stringContaining('no flat replacement')]);
    });

    it('fails a catalog passage with a clause added to its sentence', () => {
        const real = readFileSync(join(ROOT, 'skill/interpolation.md'), 'utf8');
        const added = real.replace('`{name_gender, select, …}` in the translation.', '`{name_gender, select, …}` in the translation, and you may write the same select into your own phrase.');
        expect(added).not.toBe(real);
        expect(scanSurface('skill/interpolation.md', added, EXEMPT).map((f) => f.problem)).toEqual([
            expect.stringContaining('not found'),
            expect.stringContaining('ICU construct in a phrase'),
        ]);
    });

    it('fails an exempt passage that holds no construct, since it exempts nothing', () => {
        const stale: ExemptPassage = { file: 'x.md', role: 'catalog', text: 'Langsys sends `{count} files` in the translation.', mark: 'Langsys' };
        expect(scanSurface('x.md', stale.text, [stale]).map((f) => f.problem)).toEqual([expect.stringContaining('holds no ICU construct')]);
    });

    const row: ExemptPassage = { file: 'x.md', role: 'counter-example', text: '`{n, plural, …}` written by hand', mark: 'written by hand', flatBeside: "t('{n} files'" };
    it('allows a table row whose Do cell holds the flat phrase, and fails it once that cell is gone or holds ICU itself', () => {
        expect(scanSurface('x.md', "| `t('{n} files', 'A', { n })` | `{n, plural, …}` written by hand |", [row])).toEqual([]);
        expect(scanSurface('x.md', '| | `{n, plural, …}` written by hand |', [row]).map((f) => f.problem)).toEqual([expect.stringContaining('no flat replacement')]);
        expect(scanSurface('x.md', "| `t('{n} files {n, plural, one {#} other {#}}')` | `{n, plural, …}` written by hand |", [row]).map((f) => f.problem)).toEqual([
            expect.stringContaining('no flat replacement'),
            expect.stringContaining('ICU construct in a phrase'),
        ]);
    });

    it('fails a second copy of an exempt passage, and a construct outside it', () => {
        const twice = `${marked}\n${marked.split('\n')[1]}`;
        expect(scanSurface('x.md', twice, [counterExample]).map((f) => f.problem)).toEqual([
            expect.stringContaining('more than once'),
            expect.stringContaining('ICU construct in a phrase'),
        ]);
        const other = `${marked}\nt('{n, plural, one {#} other {#}}', 'A', { n });`;
        expect(scanSurface('x.md', other, [counterExample]).map((f) => f.problem)).toEqual([expect.stringContaining('ICU construct in a phrase')]);
    });

    it('fails an exempt passage that no longer exists, so a reworded passage is decided again', () => {
        expect(scanSurface('x.md', flat, [counterExample]).map((f) => f.problem)).toEqual([expect.stringContaining('not found')]);
    });

    it("names a hashed declaration chunk once, whatever its hash's characters and whichever module flavour, and leaves other paths as they are", () => {
        expect(surfaceName('dist/pure-LMoN2tmu.d.ts')).toBe('dist/pure-[hash].d.ts');
        expect(surfaceName('dist/pure-LMoN2tmu.d.mts')).toBe('dist/pure-[hash].d.ts');
        expect(surfaceName('dist/pure-DMk-W2Ud.d.ts')).toBe('dist/pure-[hash].d.ts');
        expect(surfaceName('dist/pure-_a-b_c-d.d.mts')).toBe('dist/pure-[hash].d.ts');
        expect(surfaceName('dist/category-ref-AbCd_123.d.ts')).toBe('dist/category-ref-[hash].d.ts');
        expect(surfaceName('dist/index.d.mts')).toBe('dist/index.d.ts');
        expect(surfaceName('dist/index.mjs')).toBe('dist/index.mjs');
        expect(surfaceName('skill/value-markers.md')).toBe('skill/value-markers.md');
    });

    it('lists the shipped files as npm publishes them: no .DS_Store, and a negated files entry honoured', () => {
        const dir = mkdtempSync(join(tmpdir(), 'icu7-pack-'));
        try {
            const files: Record<string, string> = {
                'package.json': JSON.stringify({ name: 'probe', version: '1.0.0', files: ['dist', '!dist/*.map', 'skill', '!skill/drafts'] }),
                'README.md': '# Probe\n',
                'skill/a.md': 'Write `You have {count} new messages`.\n',
                'skill/.DS_Store': '',
                'skill/drafts/x.md': '',
                'dist/index.js': '',
                'dist/index.js.map': '',
            };
            for (const [path, text] of Object.entries(files)) {
                mkdirSync(dirname(join(dir, path)), { recursive: true });
                writeFileSync(join(dir, path), text);
            }
            expect(shippedFiles(dir)).toEqual(['README.md', 'dist/index.js', 'package.json', 'skill/a.md']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does not read the changelog', () => {
        expect(OUTSIDE.has('CHANGELOG.md')).toBe(true);
        expect(SURFACES).not.toContain('CHANGELOG.md');
    });
});
