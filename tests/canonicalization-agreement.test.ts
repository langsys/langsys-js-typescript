// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import fixture from './fixtures/canonicalization-reference.json';

/**
 * Identity agreement across the Langsys SDKs, over the canonicalization rules
 * added this round: U+00A0 collapse, attribute values collapsing internal
 * whitespace like text nodes, and the fixed twenty-seven translatable
 * attributes in their fixed order.
 *
 * `canonicalization-reference.json` is AUTHORED HERE, not vendored — unlike the
 * three fixtures from `langsys-php`. It records each lane's MEASURED output
 * beside the expectation, so a divergence names the lane rather than being
 * argued about. Other lanes row against the same file.
 *
 * Codepoints are carried for every input and expectation because several cases
 * differ only by U+00A0 or U+2028, which render identically to a space. Without
 * them a report reads as "the tokens are the same but the hashes differ", which
 * is not a thing that can happen and wasted a pass of this very comparison.
 *
 * Only `langsys2` is absent as a minter, and that is a measurement too: it has
 * none. Searched by hashing call and by canonical-serialization signature, with
 * the same searches positive-controlled against `langsys-php-sdk` — four hits
 * there, zero in the server. It stores the ids clients send.
 */

interface Row {
    id: string;
    why: string;
    html: string;
    category: string;
    expected_tokens: string[];
    expected_custom_id: string;
    agree: boolean;
    divergence?: string;
    parser_dependent?: string;
}

const doc = fixture as unknown as { cases: Row[]; agreement: { rows: number; agree: number; diverge: number } };

function tokensOf(html: string): string[] {
    const host = document.createElement('div');
    host.innerHTML = html;
    return tokenizeElement(host).tokens;
}

describe('this SDK matches every published expectation', () => {
    it('the fixture is whole', () => {
        expect(doc.cases).toHaveLength(doc.agreement.rows);
    });

    it.each(doc.cases.map((c) => [c.id, c] as const))('%s', (_id, row) => {
        // The expectations ARE this SDK's output, so these cannot fail today.
        // They are here to fail LATER: a canonicalization change that moves an
        // id breaks this file, and the other lanes row against the same one, so
        // the break is visible to everybody rather than to whoever notices a
        // re-registration first.
        expect(tokensOf(row.html)).toEqual(row.expected_tokens);
        expect(generateCustomId(row.category, tokensOf(row.html))).toBe(row.expected_custom_id);
    });
});

describe('the recorded divergences are still divergences', () => {
    // Self-cleaning, like the tokenizer-reference override. A row whose
    // `divergence` note has been fixed upstream should stop being listed, and
    // leaving stale notes is how a file like this becomes untrustworthy.
    const diverging = doc.cases.filter((c) => !c.agree);

    it('every divergence names a lane and a reason', () => {
        expect(diverging.length).toBeGreaterThan(0);
        for (const row of diverging) {
            expect(row.divergence, `${row.id} is marked divergent with no explanation`).toBeTruthy();
        }
    });

    it('and the count matches the header, computed not asserted', () => {
        expect(diverging).toHaveLength(doc.agreement.diverge);
        expect(doc.cases.filter((c) => c.agree)).toHaveLength(doc.agreement.agree);
    });
});

describe('the three named canonicalization rules are each covered', () => {
    // The operator asked for these three specifically, so their presence is
    // asserted rather than assumed from a row count.
    it('non-breaking spaces', () => {
        const ids = doc.cases.map((c) => c.id);
        expect(ids).toContain('nbsp-in-text');
        expect(ids).toContain('attr-nbsp');
        expect(ids).toContain('nbsp-vs-plain-space');
    });

    it('attribute values collapsing internal whitespace', () => {
        const attr = doc.cases.find((c) => c.id === 'attr-multiline')!;
        const text = doc.cases.find((c) => c.id === 'text-multiline')!;
        // The whole point of TOK-4: the same sentence, one in an attribute and
        // one in a text node, must reach the same id.
        expect(attr.expected_custom_id).toBe(text.expected_custom_id);
    });

    it('the fixed translatable-attribute list, including order', () => {
        const ids = doc.cases.map((c) => c.id);
        expect(ids).toContain('attr-original-15');
        expect(ids).toContain('attr-new-data-confirm');
        expect(ids).toContain('attr-all-new-twelve');
        // Order is identity, so a case where document order contradicts list
        // order has to be in here.
        expect(ids).toContain('attr-order-two-on-one-element');
    });
});
