import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * INVARIANT — no RAW invisible character appears in our own sources or fixtures.
 *
 * Spec 8.0.1 states the rule and cites this lane as the reason it is stated:
 * "Write the character as an escape in the test, never as a literal … (The
 * TypeScript lane's vector was written with a literal, discriminated correctly,
 * and was rewritten as an escape for exactly this reason.)"
 *
 * Two distinct harms, and the second is the one that bites:
 *
 *  1. A reviewer cannot see what a test is about. `'A long description'` with a
 *     literal U+00A0 in it renders identically to one with a space, so the
 *     assertion reads as being about ordinary spaces.
 *  2. A FORMATTER OR EDITOR SILENTLY REMOVES IT. U+FEFF is the worst case — every
 *     BOM-stripper in existence deletes it, and a fixture row whose whole purpose
 *     is "U+FEFF collapses like a space" then asserts that an empty string does.
 *     The test still passes. The id still matches. The row now proves nothing, and
 *     nothing announces it.
 *
 * Found by the Reviewer, who decoded the file rather than reading it: the commit
 * adding the U+FEFF row wrote 13 raw invisibles into the vector file, including
 * the one codepoint editors remove, and re-serialised the whole file so the diff
 * was unreviewable. Escaping is not cosmetic here — it is what makes the fixture
 * survive ordinary tooling.
 */

/**
 * Codepoints that must be written as an escape. Every one is either invisible or
 * renders indistinguishably from a space, and each appears in an identity rule:
 * TOK-2's collapse set, and the characters 8.0.1 names as non-members.
 */
const MUST_BE_ESCAPED: Record<number, string> = {
    0x00a0: 'NO-BREAK SPACE',
    0x0085: 'NEXT LINE',
    0x180e: 'MONGOLIAN VOWEL SEPARATOR',
    0xfeff: 'ZERO WIDTH NO-BREAK SPACE (BOM)',
    0x2028: 'LINE SEPARATOR',
    0x2029: 'PARAGRAPH SEPARATOR',
    0x200b: 'ZERO WIDTH SPACE',
    0x2060: 'WORD JOINER',
    0x2007: 'FIGURE SPACE',
    0x1680: 'OGHAM SPACE MARK',
    0x202f: 'NARROW NO-BREAK SPACE',
    0x205f: 'MEDIUM MATHEMATICAL SPACE',
    0x3000: 'IDEOGRAPHIC SPACE',
    0x000b: 'LINE TABULATION',
    0x000c: 'FORM FEED',
};

/**
 * VENDORED fixtures are exempt, and the exemption is the point rather than a
 * loophole: `CLAUDE.md` forbids editing them, since they are langsys-php's copy of
 * the shared contract and re-vendoring is the only legitimate way they change.
 * `custom-id-reference.json` carries raw U+2028/U+2029 today.
 *
 * Named individually, never as a directory glob — `tests/fixtures/` also holds
 * `canonicalization-reference.json`, which is AUTHORED here and is the file this
 * check exists for. A glob would have exempted exactly the wrong file.
 */
const VENDORED = new Set([
    'tests/fixtures/custom-id-reference.json',
    'tests/fixtures/tokenizer-reference.json',
    'tests/fixtures/interpolation-reference.json',
]);

const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.json'];

function filesUnder(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return filesUnder(full);
        return SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext)) ? [full] : [];
    });
}

interface Hit {
    file: string;
    codepoint: string;
    name: string;
    line: number;
    count: number;
}

const NEWLINE = String.fromCodePoint(10);

function scan(text: string, label: string): Hit[] {
    const found = new Map<number, Hit>();
    let line = 1;
    for (const ch of text) {
        if (ch === NEWLINE) {
            line++;
            continue;
        }
        const cp = ch.codePointAt(0)!;
        const name = MUST_BE_ESCAPED[cp];
        if (!name) continue;
        const hit = found.get(cp);
        if (hit) {
            hit.count++;
            continue;
        }
        found.set(cp, {
            file: label,
            codepoint: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'),
            name,
            line,
            count: 1,
        });
    }
    return [...found.values()];
}

describe('the scanner can actually find a raw invisible', () => {
    // Without this, the clean result below could be a scanner that reads nothing.
    // Built with String.fromCodePoint so the control does not itself contain the
    // literals it looks for — a control written with raw characters would be
    // destroyed by the very formatter this test defends against.
    it('detects every codepoint it claims to', () => {
        for (const cp of Object.keys(MUST_BE_ESCAPED).map(Number)) {
            const planted = 'a' + String.fromCodePoint(cp) + 'b';
            const hits = scan(planted, 'synthetic');
            expect(hits, `U+${cp.toString(16)} was not detected`).toHaveLength(1);
            expect(hits[0]!.count).toBe(1);
        }
    });

    it('does not fire on an escape, which is the form being required', () => {
        // The backslash is ASSEMBLED rather than typed. Writing `\u00a0` as a
        // literal here is how this file first failed its own scan: the sequence got
        // interpreted on the way to disk and became the character it is testing for.
        // Which is the hazard in miniature, and the scanner caught it.
        const BS = String.fromCodePoint(92);
        expect(scan(`const s = 'A${BS}u00a0long';`, 'synthetic')).toEqual([]);
        expect(scan(`${BS}ufeff ${BS}u0085 ${BS}u180e`, 'synthetic')).toEqual([]);
    });

    it('and does not fire on visible non-ASCII', () => {
        // Emoji and accented letters are readable, so they are not the problem and
        // must not be flagged — the `non-bmp` fixture row depends on that.
        expect(scan('Café 😀 日本語 — ordinary', 'synthetic')).toEqual([]);
    });
});

describe('INVARIANT: no raw invisible characters in our own sources', () => {
    it('holds across src/ and tests/', () => {
        const offenders = [...filesUnder('src'), ...filesUnder('tests')]
            .map((file) => relative(process.cwd(), file))
            .filter((file) => !VENDORED.has(file))
            .flatMap((file) => scan(readFileSync(file, 'utf8'), file))
            .map((h) => `${h.file}:${h.line} has ${h.count}x raw ${h.codepoint} (${h.name}) — write it as an escape`);

        expect(offenders).toEqual([]);
    });

    it('and the vendored exemptions still exist, so the list cannot rot silently', () => {
        // An exemption naming a file that is gone is an exemption nobody notices is
        // doing nothing — and if one were renamed, the scan would start failing on a
        // file we are not allowed to edit, with no hint as to why it was exempt.
        for (const file of VENDORED) {
            expect(
                () => readFileSync(join(process.cwd(), file), 'utf8'),
                `${file} is exempted but missing`
            ).not.toThrow();
        }
    });

    it('the authored vector file is NOT exempt, and is the reason this exists', () => {
        const path = 'tests/fixtures/canonicalization-reference.json';
        expect(VENDORED.has(path)).toBe(false);
        const text = readFileSync(join(process.cwd(), path), 'utf8');
        expect(scan(text, 'vector')).toEqual([]);
        // And it really does carry those characters, as escapes -- so "clean" cannot
        // be satisfied by the rows having been quietly dropped. Backslash assembled,
        // for the reason given in the escape-form test above.
        const BS = String.fromCodePoint(92);
        expect(text).toContain(BS + 'ufeff');
        expect(text).toContain(BS + 'u0085');
        expect(text).toContain(BS + 'u180e');
    });
});
