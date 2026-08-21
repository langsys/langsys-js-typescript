import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateCustomId, generateLegacyCustomId } from '../src/content-block.js';
import { md5, md5Legacy } from '../src/utils.js';

/**
 * `md5` once hashed UTF-16 code units packed into byte slots, which is correct
 * only for ASCII — so every content block containing an accent, CJK character
 * or emoji was stored under an id no standard md5 produces. The fix shipped in
 * 0.6.0 alongside the legacy lookup fallback; these are its conformance
 * vectors, which the suite did not otherwise have.
 *
 * The reference here is `node:crypto` — an INDEPENDENT implementation. The
 * original table was verified by checking `generateCustomId` against
 * `md5(JSON.stringify(...))`, which agreed because both call the same broken
 * hash. Self-consistency proves determinism, not correctness.
 */

const ref = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/**
 * Vectors are built from codepoints, never typed as glyphs.
 *
 * A glyph in a source file is re-typed by whoever ports it, and re-typing is
 * where the defect enters — an earlier version of the migration table carried
 * an "NFD" row that was actually NFC because it had been typed rather than
 * composed. `cp` makes the bytes an assertion rather than an assumption.
 */
const cp = (...points: number[]) => String.fromCodePoint(...points);

const CAFE_NFC = cp(0x43, 0x61, 0x66, 0xe9); // Café — e-acute precomposed
const CAFE_NFD = cp(0x43, 0x61, 0x66, 0x65, 0x301); // Café — e + combining acute
const CJK = cp(0x65e5, 0x672c, 0x8a9e); // 日本語
const CYRILLIC = cp(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442); // Привет
const GREEK = cp(0x39a, 0x3b1, 0x3bb, 0x3b7, 0x3bc, 0x3ad, 0x3c1, 0x3b1); // Καλημέρα
const HEBREW = cp(0x5e9, 0x5dc, 0x5d5, 0x5dd); // שלום
const ARABIC = cp(0x645, 0x631, 0x62d, 0x628, 0x627); // مرحبا
const EMOJI = cp(0x1f44d); // 👍 — non-BMP, a surrogate pair in UTF-16

describe('md5 hashes UTF-8 bytes', () => {
    const cases = [
        ['ascii', 'Hello'],
        ['json envelope', JSON.stringify(['UI', ['Hello']])],
        ['latin-1 range (e-acute)', JSON.stringify(['UI', [CAFE_NFC]])],
        ['CJK', JSON.stringify(['UI', [CJK]])],
        ['Cyrillic', JSON.stringify(['UI', [CYRILLIC]])],
        ['Greek', JSON.stringify(['UI', [GREEK]])],
        ['Hebrew (RTL)', JSON.stringify(['UI', [HEBREW]])],
        ['Arabic (RTL)', JSON.stringify(['UI', [ARABIC]])],
        ['emoji (non-BMP)', JSON.stringify(['UI', [EMOJI]])],
        ['combining mark (NFD)', JSON.stringify(['UI', [CAFE_NFD]])],
    ] as const;

    for (const [label, input] of cases) {
        it(`matches an independent implementation: ${label}`, () => {
            expect(md5(input)).toBe(ref(input));
        });
    }
});

describe('the legacy hash is retained for lookup-only fallback', () => {
    it('reproduces the pre-fix id exactly', () => {
        // The values actually stored for content registered before 0.6.0.
        // Lookup-only: never register under these. The legacy hash also has
        // real collisions (see below), so the id space is not injective and
        // re-keying stored rows is not possible even in principle.
        expect(generateLegacyCustomId('UI', [CAFE_NFC])).toBe('d7bcece3a271c363eeff4d73d2257c85');
        expect(generateLegacyCustomId('UI', [CAFE_NFD])).toBe('4275c43754477edb6e305bb3aee31fea');
    });

    it('agrees with the corrected hash for ASCII — those blocks need no migration', () => {
        for (const tokens of [['Hello'], ['Hello', 'World'], ['a/b'], ['say "hi"']]) {
            expect(generateLegacyCustomId('UI', tokens)).toBe(generateCustomId('UI', tokens));
        }
    });

    it('DIVERGES above U+00FF in a way no character encoding reproduces', () => {
        // The packing shift is unmasked, so a code unit above 0xFF bleeds into
        // the adjacent byte rather than truncating. A PHP port using
        // mb_convert_encoding to ISO-8859-1 reproduces the latin-1 range and
        // silently fails here — which is Chinese, Japanese, Korean, Russian,
        // Greek, Hebrew and Arabic.
        for (const tokens of [[CJK], [CYRILLIC], [GREEK], [HEBREW], [ARABIC], [EMOJI]]) {
            expect(generateLegacyCustomId('UI', tokens)).not.toBe(generateCustomId('UI', tokens));
        }
    });

    it('does not coalesce, because it must reproduce what was stored', () => {
        expect(generateLegacyCustomId(undefined as unknown as string, ['Hello'])).toBe(
            md5Legacy(JSON.stringify([null, ['Hello']])),
        );
    });

    it('DELIBERATELY disagrees with generateCustomId on an absent category', () => {
        // This asymmetry looks like an oversight and is load-bearing. If someone
        // "tidies" legacyCustomId to coalesce like its sibling, the migration
        // stops finding rows an untyped caller stored under the [null, …] form —
        // silently, since the ids it computes are still perfectly valid ids.
        // A red test is the only thing that explains that to the person editing.
        expect(generateLegacyCustomId(undefined as unknown as string, ['Hello'])).not.toBe(
            generateLegacyCustomId('', ['Hello']),
        );
        expect(generateCustomId(undefined as unknown as string, ['Hello'])).toBe(
            generateCustomId('', ['Hello']),
        );
    });
});

describe('generateCustomId coalesces at runtime, not only in the type', () => {
    it('treats undefined and null category as the empty string', () => {
        const empty = generateCustomId('', ['Hello']);
        expect(generateCustomId(undefined as unknown as string, ['Hello'])).toBe(empty);
        expect(generateCustomId(null as unknown as string, ['Hello'])).toBe(empty);
    });

    it('never emits the [null, …] form an untyped caller could otherwise produce', () => {
        expect(generateCustomId(undefined as unknown as string, ['Hello'])).not.toBe(
            md5(JSON.stringify([null, ['Hello']])),
        );
    });

    it('keeps empty and named categories distinct', () => {
        // One variable: ASCII tokens throughout, so only the category differs.
        expect(generateCustomId('', ['Hello'])).not.toBe(generateCustomId('UI', ['Hello']));
    });

    it('an empty category is unaffected by the hash fix when its tokens are ASCII', () => {
        // Guards against reading "empty category" as a migration-affected case:
        // the category never was. Only non-ASCII TOKENS move an id.
        expect(generateLegacyCustomId('', ['Hello'])).toBe(generateCustomId('', ['Hello']));
    });
});
