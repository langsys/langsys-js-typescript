import { describe, expect, it } from 'vitest';
import { canonicalContentBlockJson, generateCustomId } from '../src/content-block.js';
import fixture from './fixtures/custom-id-reference.json';

/**
 * Cross-implementation assertion against langsys-php's shared fixture.
 *
 * Vendored from `langsys-php-sdk` @ `8862841`,
 * `tests/fixtures/custom-id-reference.json`. Vendored rather than fetched, so
 * the suite is hermetic and a fixture change arrives as a reviewable diff.
 *
 * The point is NOT that the numbers look right — I could have produced those
 * myself, and a value re-derived in TypeScript proves nothing because both
 * sides would share the mistake. The point is that two independently written
 * serializers, in different languages, emit the same BYTES: PHP's
 * `json_encode(..., JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_LINE_TERMINATORS)`
 * and JavaScript's `JSON.stringify`. Agreement there eliminates implementation
 * error and leaves only spec-level error.
 *
 * The third flag is load-bearing and was found by sweeping 78 codepoints
 * against both flag sets: without `JSON_UNESCAPED_LINE_TERMINATORS`, PHP
 * escapes U+2028/U+2029 while `JSON.stringify` emits them raw, and the two
 * hashes diverge. Row 13 exists to hold that.
 */

interface Row {
    category: string;
    tokens: string[];
    canonical_json: string;
    custom_id: string;
    serialized_hex: string;
    codepoints: { category: string[]; tokens: string[][] };
}

const rows = fixture as unknown as Row[];

function toCodepoints(s: string): string[] {
    return [...s].map((ch) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'));
}

describe('CID-1: custom_id agrees with langsys-php byte-for-byte', () => {
    it('vendored the whole fixture, not a convenient subset', () => {
        expect(rows).toHaveLength(13);
    });

    it.each(rows.map((r, i) => [i + 1, r] as const))('row %i', (_i, row) => {
        // 1. The vendored bytes are what PHP wrote. Checked FIRST, because an
        //    editor or a git filter normalising U+2028 out of this file would
        //    otherwise make every assertion below pass against mangled input.
        expect(toCodepoints(row.category)).toEqual(row.codepoints.category);
        row.tokens.forEach((t, j) => expect(toCodepoints(t)).toEqual(row.codepoints.tokens[j]));

        // 2. Same string. Derived from the function `generateCustomId` calls,
        //    never re-expressed here — a parallel reimplementation agrees with
        //    itself and keeps agreeing after the real one changes.
        const canonical = canonicalContentBlockJson(row.category, row.tokens);
        expect(canonical).toBe(row.canonical_json);

        // 3. Same bytes.
        expect(Buffer.from(canonical, 'utf8').toString('hex')).toBe(row.serialized_hex);

        // 4. Same id, through the public contract.
        expect(generateCustomId(row.category, row.tokens)).toBe(row.custom_id);
    });

    it('row 13 really does carry raw U+2028/U+2029, which is the whole point of it', () => {
        // A positive control on the fixture itself. If this row ever stops
        // carrying line separators, the rows above still pass and the encoding
        // edge silently stops being covered.
        const row13 = rows[12]!;
        const flat = row13.codepoints.tokens.flat();
        expect(flat).toContain('U+2028');
        expect(flat).toContain('U+2029');
        expect(row13.serialized_hex).toContain('e280a8');
        expect(row13.serialized_hex).toContain('e280a9');
    });
});
