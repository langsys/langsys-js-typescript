// The documentation check behind ICU-7: phrases are written flat, so no surface this package ships
// writes a `plural`, `select` or `selectordinal` into a phrase. ICU appears in three roles only,
// each a named exempt passage (see `docs-icu7.test.ts`): what the catalog returns, what MIG-4
// converts a legacy plural file into, and a counter-example marked wrong beside its flat phrase.
// It is langsys-js-react's and langsys-js-vue's check, with three additions this package needs: a
// flat phrase may share its counter-example's line (a Do / Don't table row), a build chunk is named
// without its hash, and a construct is found across a comment's or a blockquote's line breaks.

/**
 * An ICU argument that selects a branch: `{count, plural, …}`, `{name_gender, select, …}`, `{0, plural, …}`.
 * The argument is any name ICU takes (a number, or letters of any script), and the gaps between its parts may
 * cross a line break into a doc comment's `*`, a blockquote's `>` or a line comment's `//`.
 */
export const ICU_CONSTRUCT = /\{[\s*>/]*[^\s{},*>/]+[\s*>/]*,[\s*>/]*(?:plural|select|selectordinal)\b/g;

export type ExemptRole = 'catalog' | 'mig-4' | 'counter-example';

export interface ExemptPassage {
    /** The surface's name: its path from the repository root, forward slashes, a build chunk's hash written `[hash]` (`surfaceName`). */
    file: string;
    role: ExemptRole;
    /**
     * Text the passage must contain exactly once in the file. Every construct it exempts sits inside it, and so
     * do the words that give it its role (who makes the form, or that a translation holds it), so rewording
     * them is a new passage, decided again.
     */
    text: string;
    /** The passage's first line must also hold this, which is what shows it for what it is (`❌`, or the words that say a translation holds it). */
    mark: string;
    /**
     * `counter-example` only: the flat phrase that replaces it, on an adjacent line or on the passage's own line
     * outside the passage (a Do / Don't table row), holding this and no construct.
     */
    flatBeside?: string;
}

export interface Finding {
    file: string;
    line: number;
    problem: string;
}

/**
 * A surface's name, from its path: a declaration chunk's content hash becomes `[hash]` and both module
 * flavours of a declaration file share one name (`dist/pure-LMoN2tmu.d.mts` is `dist/pure-[hash].d.ts`), so an
 * exempt passage names the declaration once and survives a rebuild that renames the chunk. tsup names a chunk
 * `[name]-[hash]`, the hash eight characters of base64url, `-` and `_` included.
 */
export function surfaceName(path: string): string {
    return path.replace(/^(dist\/[^/]+?)-[A-Za-z0-9_-]{8}(\.d\.m?ts)$/, '$1-[hash]$2').replace(/\.d\.mts$/, '.d.ts');
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const holdsConstruct = (text: string): boolean => new RegExp(ICU_CONSTRUCT.source).test(text);

/** What is wrong in one surface: an ICU construct no exempt passage covers, or an exempt passage that is missing, repeated or no longer marked. */
export function scanSurface(file: string, text: string, exempt: readonly ExemptPassage[]): Finding[] {
    const findings: Finding[] = [];
    const lines = text.split('\n');
    const spans: Array<[number, number]> = [];

    for (const passage of exempt.filter((p) => p.file === file)) {
        const first = text.indexOf(passage.text);
        if (first === -1) {
            findings.push({ file, line: 0, problem: `exempt passage (${passage.role}) not found: ${JSON.stringify(passage.text)}` });
            continue;
        }
        const line = lineOf(text, first);
        if (text.indexOf(passage.text, first + 1) !== -1) {
            findings.push({ file, line, problem: `exempt passage (${passage.role}) appears more than once: ${JSON.stringify(passage.text)}` });
        }
        spans.push([first, first + passage.text.length]);
        const own = lines[line - 1] ?? '';
        if (!own.includes(passage.mark)) {
            findings.push({ file, line, problem: `exempt passage (${passage.role}) lost its marking ${JSON.stringify(passage.mark)}` });
        }
        if (passage.role === 'counter-example') {
            const flat = passage.flatBeside;
            const ownRest = passage.text.includes('\n') ? '' : own.replace(passage.text, '');
            const beside = [lines[line - 2], ownRest, lines[line]].filter(
                (l): l is string => l !== undefined && flat !== undefined && l.includes(flat) && !holdsConstruct(l),
            );
            if (beside.length === 0) {
                findings.push({ file, line, problem: `counter-example has no flat replacement (a line holding ${JSON.stringify(flat)}) beside it` });
            }
        }
    }

    for (const match of text.matchAll(ICU_CONSTRUCT)) {
        const at = match.index ?? 0;
        if (!spans.some(([from, to]) => at >= from && at < to)) {
            const line = lineOf(text, at);
            findings.push({ file, line, problem: `ICU construct in a phrase, not an exempt passage: ${(lines[line - 1] ?? '').trim()}` });
        }
    }
    return findings;
}
