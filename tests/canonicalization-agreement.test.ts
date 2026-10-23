// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { encodeRichText } from '../src/richtext.js';
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

interface LaneMeasurement {
    tokens: string[];
    custom_id: string;
    /** The content the lane registers the block with, on a row that pins it. */
    content?: string;
}

interface Row {
    id: string;
    why: string;
    html: string;
    category: string;
    expected_tokens: string[];
    expected_custom_id: string;
    /** The content a block registers with for this html (VAR-3), where the row pins it. */
    expected_content?: string;
    measured: Record<string, LaneMeasurement | null>;
    agree: boolean;
    divergence?: string;
    parser_dependent?: string;
    added_by?: string;
    /** Lanes that have not measured this row yet; each one's `measured` entry is null until it does. */
    awaiting?: string[];
}

/** A rich phrase (`<Phrase>`), keyed by its encoded string (TOK-1). */
interface PhraseRow {
    id: string;
    why: string;
    html: string;
    expected_phrase: string;
    expected_values: Record<string, string>;
    registers: boolean;
    /** The key the JS family's reader produced for this host before TOK-1 bound rich phrases. */
    earlier_phrase?: string;
    added_by: string;
    awaiting?: string[];
    measured: Record<string, { phrase: string; values: Record<string, string>; registers: boolean; earlier_phrase?: string } | null>;
    agree: boolean;
}

const doc = fixture as unknown as {
    cases: Row[];
    phrase_cases: PhraseRow[];
    phrase_agreement: { rows: number; agree: number; diverge: number };
    agreement: { rows: number; agree: number; diverge: number };
    resolved_divergences: { note: string; rows: { row: string; was: string; now: string; note: string }[] };
};

function tokenized(html: string): { tokens: string[]; content: string } {
    const host = document.createElement('div');
    host.innerHTML = html;
    return tokenizeElement(host);
}
const tokensOf = (html: string) => tokenized(html).tokens;

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
        if (row.expected_content !== undefined) expect(tokenized(row.html).content).toBe(row.expected_content);
    });

    it('the stored-content rows cover a run, an element slot, a translate="no" element and the attribute form', () => {
        // VAR-3's Test names these shapes; asserted by id so a dropped row fails here.
        const pinned = doc.cases.filter((c) => c.expected_content !== undefined).map((c) => c.id);
        expect(pinned).toEqual(['var-content-run', 'var-content-slot', 'var-content-translate-no', 'var-content-attr']);
        // The content holds the placeholder and neither the value nor a marker.
        for (const row of doc.cases.filter((c) => c.expected_content !== undefined)) {
            expect(row.expected_content).toMatch(/\{(email|name)\}/);
            expect(row.expected_content).not.toMatch(/a@b\.c|Ana|ls:|data-ls-param/);
        }
    });
});

describe('this SDK keys every rich phrase as published (phrase_cases, TOK-1)', () => {
    const encoded = (html: string) => {
        const host = document.createElement('span');
        host.innerHTML = html;
        return encodeRichText(host);
    };

    it('the rows are whole, and cover each shape TOK-1 names', () => {
        expect(doc.phrase_cases).toHaveLength(doc.phrase_agreement.rows);
        expect(doc.phrase_cases.map((row) => row.id)).toEqual([
            'tok1-rich-no-literal',
            'tok1-rich-no-marked',
            'tok1-rich-no-mixed',
            'tok1-rich-notrans-literal',
            'tok1-rich-notrans-marked',
            'tok1-rich-notrans-mixed',
            'tok1-rich-notrans-false',
            'tok1-rich-script',
            'tok1-rich-slot-numbering',
            'tok1-rich-param-inside',
            'tok1-rich-opaque-only',
            'tok1-rich-earlier-key',
            'tok1-rich-earlier-key-control',
        ]);
        // Every excluded form of the same sentence is the one key.
        const sentence = doc.phrase_cases.filter((row) => /^tok1-rich-(no|notrans)-(literal|marked|mixed)$/.test(row.id));
        expect(new Set(sentence.map((row) => row.expected_phrase))).toEqual(new Set(['Signed in as {m0o}{m0c} today']));
    });

    it.each(doc.phrase_cases.map((row) => [row.id, row] as const))('%s', (_id, row) => {
        const { phrase, values, earlier } = encoded(row.html);
        expect(phrase).toBe(row.expected_phrase);
        expect(values).toEqual(row.expected_values);
        if (row.earlier_phrase !== undefined) expect(earlier?.phrase ?? phrase).toBe(row.earlier_phrase);
    });

    it('the earlier key is beside the current one where the key moved, and equal to it on the control', () => {
        const moved = doc.phrase_cases.find((row) => row.id === 'tok1-rich-earlier-key')!;
        const control = doc.phrase_cases.find((row) => row.id === 'tok1-rich-earlier-key-control')!;
        expect(moved.earlier_phrase).not.toBe(moved.expected_phrase);
        expect(encoded(moved.html).earlier?.phrase).toBe(moved.earlier_phrase);
        expect(control.earlier_phrase).toBe(control.expected_phrase);
        expect(encoded(control.html).earlier).toBeUndefined();
    });

    it('each row records every lane that measured it as agreeing, and every other lane as awaited until it measures', () => {
        let agreed = 0;
        let checked = 0;
        for (const row of doc.phrase_cases) {
            expect(row.added_by).toBe('spec 8.5.9 TOK-1 exclusion');
            for (const lane of row.awaiting ?? []) expect(row.measured[lane], `${row.id}: ${lane} is awaited but has a measurement`).toBeNull();
            expect(row.measured['langsys-js-typescript'], `${row.id}: the JS lane, which authors the row, must have measured it`).not.toBeNull();
            for (const [lane, m] of Object.entries(row.measured)) {
                if (m === null || !row.agree) continue;
                expect(m.phrase, `${row.id}: ${lane}'s phrase`).toBe(row.expected_phrase);
                expect(m.values, `${row.id}: ${lane}'s values`).toEqual(row.expected_values);
                expect(m.registers, `${row.id}: ${lane}'s registration`).toBe(row.registers);
                expect(m.earlier_phrase, `${row.id}: ${lane}'s earlier key`).toBe(row.earlier_phrase);
                checked++;
            }
            if (row.agree) agreed++;
        }
        // Two measuring lanes per agreed row, less the lanes it still awaits.
        expect(checked).toBe(doc.phrase_cases.reduce((n, row) => n + (row.agree ? 2 - (row.awaiting?.length ?? 0) : 0), 0));
        expect(agreed).toBe(doc.phrase_agreement.agree);
        expect(doc.phrase_cases.length - agreed).toBe(doc.phrase_agreement.diverge);
    });
});

describe('the file is internally consistent about who agrees', () => {
    /**
     * This block used to be `the recorded divergences are still divergences` and
     * its first assertion was `diverging.length > 0`. It FIRED when PHP's fixes
     * landed and the count reached zero — which is the mechanism working, not a
     * broken test: it existed to stop stale divergence notes accumulating here,
     * and with no divergence left it had to be retired rather than relaxed.
     *
     * What replaces it has to survive the empty case without becoming a pass that
     * cannot fail. A bare `diverging.every(...)` over an empty array is `true`
     * forever — the same defect that let `leaves the default host in place when
     * apiUrl is absent` sit green in this suite with no request ever issued. So
     * every assertion below is either over every row or guarded by a count.
     */
    it('every row called agreed really does agree, per its own measured block', () => {
        // Over every row, and the assertion that catches the realistic error:
        // a re-measure pasted into `measured` while `agree` stayed true.
        let checked = 0;
        let expected = 0;
        for (const row of doc.cases) {
            // A lane still awaited has not measured, and a lane that has is no longer awaited.
            for (const lane of row.awaiting ?? []) {
                expect(row.measured[lane], `${row.id}: ${lane} is awaited but has a measurement`).toBeNull();
            }
            if (row.agree) expected += 2 - (row.awaiting?.length ?? 0);
            const lanes = Object.entries(row.measured).filter(([, m]) => m !== null) as [string, LaneMeasurement][];
            expect(lanes.length, `${row.id} records no lane measurement at all`).toBeGreaterThan(0);
            if (!row.agree) continue;
            for (const [lane, m] of lanes) {
                expect(m.custom_id, `${row.id}: ${lane} is recorded as agreeing but its id differs`).toBe(
                    row.expected_custom_id
                );
                expect(m.tokens, `${row.id}: ${lane} is recorded as agreeing but its tokens differ`).toEqual(
                    row.expected_tokens
                );
                if (row.expected_content !== undefined) {
                    expect(m.content, `${row.id}: ${lane} is recorded as agreeing but its content differs`).toBe(row.expected_content);
                }
                checked++;
            }
        }
        // Guard: if the rows or their measurements vanish, the loop above passes
        // silently. Anchored to the ROWS, not to `doc.agreement.rows` — a header
        // the file supplies cannot be the guard on a loop over that same file, and
        // `cases: []` with `rows: 0` satisfied the header form while asserting
        // nothing. Two measuring lanes per agreed row; the server has no minter.
        // The agreed count comes from the rows' `agree` flags, which the header
        // test below ties to the divergent rows' notes, so it cannot shrink
        // without a divergence being written down.
        expect(doc.cases.length).toBeGreaterThanOrEqual(20);
        expect(checked).toBe(expected);
        // Only a row a named batch added may await a lane; every other row stays measured twice.
        const batches = ['spec 8.3.0 VAR-3 value markers', 'spec 8.5.9 VAR-3 stored content'];
        for (const row of doc.cases.filter((c) => c.awaiting?.length)) {
            expect(batches, `${row.id} awaits a lane without saying which batch added it`).toContain(row.added_by);
            expect(row.measured['langsys-js-typescript'], `${row.id}: the JS lane, which authors the row, must have measured it`).not.toBeNull();
        }
    });

    it('a row that does NOT agree carries a note naming the lane', () => {
        const diverging = doc.cases.filter((c) => !c.agree);
        // Count-anchored so this is not a vacuous pass: an unnoted divergence
        // fails on the note, and a header disagreeing with the rows fails here.
        expect(diverging).toHaveLength(doc.agreement.diverge);
        for (const row of diverging) {
            expect(row.divergence, `${row.id} is marked divergent with no explanation`).toBeTruthy();
            // The JS core is the identity authority, so a divergence is always
            // another lane's: this lane's own measurement must still be the
            // expectation, and the other lane's must really differ from it.
            const js = row.measured['langsys-js-typescript'];
            expect(js?.custom_id, `${row.id}: the JS lane itself diverges`).toBe(row.expected_custom_id);
            const others = Object.entries(row.measured).filter(
                ([lane, m]) => lane !== 'langsys-js-typescript' && m !== null
            ) as [string, LaneMeasurement][];
            expect(
                others.some(([, m]) => m.custom_id !== row.expected_custom_id),
                `${row.id} is marked divergent but every lane agrees`
            ).toBe(true);
        }
    });

    it('the header counts are computed from the rows, not typed beside them', () => {
        expect(doc.cases).toHaveLength(doc.agreement.rows);
        expect(doc.cases.filter((c) => c.agree)).toHaveLength(doc.agreement.agree);
        expect(doc.agreement.agree + doc.agreement.diverge).toBe(doc.agreement.rows);
    });

    it('nothing listed as resolved is still marked divergent', () => {
        // The replacement self-cleaner, and it has content: six rows diverged at
        // the previous write and all six now agree. If a future re-measure
        // regresses one, the bookkeeping and the row disagree and this fails.
        const resolved = doc.resolved_divergences.rows;
        expect(resolved.length).toBeGreaterThan(0);
        for (const entry of resolved) {
            const row = doc.cases.find((c) => c.id === entry.row);
            expect(row, `${entry.row} is listed as resolved but is not in the file`).toBeTruthy();
            expect(row!.agree, `${entry.row} is listed as resolved yet marked divergent`).toBe(true);
            // A "resolution" where the id did not move is a bookkeeping error.
            expect(entry.was, `${entry.row} records a resolution with no change`).not.toBe(entry.now);
            // And `now` has to be the id the row actually expects, or the record
            // is a stale number that agrees with nothing. Without this the block
            // checked only that a resolution EXISTED: setting `now` to all zeroes
            // left the suite green, which is the bookkeeping it claims to catch.
            expect(entry.now, `${entry.row}: resolved 'now' must be the row's expected id`).toBe(
                row!.expected_custom_id
            );
            expect(entry.was, `${entry.row}: resolved 'was' must differ from the expected id`).not.toBe(
                row!.expected_custom_id
            );
        }
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

    it('spec 8.0.1\u2019s four specified rows are all present', () => {
        // Langsys specified these four by codepoint and expected behaviour; this
        // lane derived the ids as the fixture's owner (the CID-3 precedent for
        // who specifies versus who derives). Asserted by id so a dropped row is a
        // failure rather than a quietly shorter file.
        const ids = doc.cases.map((c) => c.id);
        for (const id of ['feff-in-text', 'nel-in-text', 'mvs-in-text', 'percent-name-in-markup']) {
            expect(ids, `spec 8.0.1 specified row ${id}`).toContain(id);
        }
    });

    it('U+FEFF collapses and the two non-members do not \u2014 as ids, not as prose', () => {
        const byId = (id: string) => doc.cases.find((c) => c.id === id)!;
        const plain = byId('nbsp-vs-plain-space').expected_custom_id;
        // A MEMBER of the collapse set: same id as the plain-space carrier.
        expect(byId('feff-in-text').expected_custom_id).toBe(plain);
        // NON-members: the character survives, so the id must differ. This is the
        // half that fails if someone "simplifies" the collapse to a broader class.
        expect(byId('nel-in-text').expected_custom_id).not.toBe(plain);
        expect(byId('mvs-in-text').expected_custom_id).not.toBe(plain);
        expect(byId('nel-in-text').expected_custom_id).not.toBe(byId('mvs-in-text').expected_custom_id);
    });

    it('%name% captured from markup reaches the {name} id', () => {
        const row = doc.cases.find((c) => c.id === 'percent-name-in-markup')!;
        expect(row.expected_tokens).toEqual(['Hello {name}']);
        // TOK-5's actual requirement: the same id as markup authored with braces.
        const braces = generateCustomId(row.category, ['Hello {name}']);
        expect(row.expected_custom_id).toBe(braces);
    });

    it('TOK-1 at 8.0.1: math excluded, svg not, both as ids', () => {
        const byId = (id: string) => doc.cases.find((c) => c.id === id)!;
        // Notation produces no token, so the id is the paragraph's own words only.
        expect(byId('math-subtree').expected_tokens).toEqual(['Area', 'units']);
        // And svg is the paired half: its text IS harvested, in document order
        // alongside the parent's own. Asserting the ORDER matters because the same
        // three strings in a different sequence is a different id.
        expect(byId('svg-inline-icon').expected_tokens).toEqual(['Click', 'go', 'to continue']);
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
