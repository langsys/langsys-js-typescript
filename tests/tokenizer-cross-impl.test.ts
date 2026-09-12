// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { canonicalContentBlockJson, generateCustomId, tokenizeElement } from '../src/content-block.js';
import fixture from './fixtures/tokenizer-reference.json';

/**
 * Cross-implementation assertion for the tokenizer, against langsys-php's
 * shared fixture. Vendored from `langsys-php-sdk` @ `5fa4d48`,
 * `tests/fixtures/tokenizer-reference.json`, blob `a8632b462c52`.
 *
 * Same machinery and the same reasons as `custom-id-cross-impl`: two
 * independently written tokenizers, in different languages, agreeing on the
 * token ARRAY — which is the identity-bearing value, since `custom_id` hashes
 * its arity and order. Re-deriving these expectations in TypeScript would
 * prove nothing; both sides would share the mistake.
 *
 * Asserted through the production functions (`tokenizeElement`,
 * `canonicalContentBlockJson`, `generateCustomId`), never a re-expression.
 */

interface Row {
    description: string;
    html: string;
    tokens: string[];
    category: string;
    canonical_json: string;
    custom_id: string;
}

const rows = fixture as unknown as Row[];

/**
 * Rows where the vendored fixture is WRONG and we deliberately diverge.
 *
 * `tokenizer-reference.json` carries a row named "script and style contents are
 * never harvested" whose expected tokens are `["Keep", "var a=1;", ".a{}"]` —
 * the name states the intent and the data encodes the opposite. Both SDKs
 * matched the data, so both harvested CSS and JavaScript as translatable
 * phrases and sent them for machine translation, while the row's name said they
 * did not. The fixture was corroborating the bug.
 *
 * The tokenizer convergence fixes the behaviour, which makes this row red. The
 * vendored copy is never edited (it is langsys-php's file), so the corrected
 * expectation lives here until the PHP lane re-derives it.
 *
 * SELF-CLEANING: the test below asserts each override still DISAGREES with the
 * fixture. When PHP corrects the row, the override becomes redundant and fails,
 * which forces its removal instead of letting a stale exception accumulate.
 */
const FIXTURE_OVERRIDES: Record<string, string[]> = {
    'script and style contents are never harvested': ['Keep'],
};

describe('the tokenizer agrees with langsys-php', () => {
    it('vendored the whole fixture', () => {
        expect(rows).toHaveLength(17);
    });

    it.each(rows.map((r) => [r.description, r] as const))('%s', (_d, row) => {
        const host = document.createElement('div');
        host.innerHTML = row.html;

        const { tokens } = tokenizeElement(host);
        const override = FIXTURE_OVERRIDES[row.description];

        if (override) {
            expect(tokens).toEqual(override);
            return;
        }

        expect(tokens).toEqual(row.tokens);

        // Arity and order are the identity, so the id must follow from them.
        expect(canonicalContentBlockJson(row.category, tokens)).toBe(row.canonical_json);
        expect(generateCustomId(row.category, tokens)).toBe(row.custom_id);
    });
});

describe('the fixture overrides are still needed', () => {
    // An override that has stopped disagreeing with the fixture is an exception
    // nobody removed. Failing here is the signal to delete it.
    it.each(Object.keys(FIXTURE_OVERRIDES))('%s still diverges from the vendored fixture', (description) => {
        const row = rows.find((r) => r.description === description);
        expect(row, `no fixture row named "${description}" — re-vendored? drop the override`).toBeDefined();
        expect(
            row!.tokens,
            `the fixture now agrees with us on "${description}" — delete this override`
        ).not.toEqual(FIXTURE_OVERRIDES[description]);
    });
});
