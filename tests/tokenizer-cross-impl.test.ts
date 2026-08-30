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

describe('the tokenizer agrees with langsys-php', () => {
    it('vendored the whole fixture', () => {
        expect(rows).toHaveLength(17);
    });

    it.each(rows.map((r) => [r.description, r] as const))('%s', (_d, row) => {
        const host = document.createElement('div');
        host.innerHTML = row.html;

        const { tokens } = tokenizeElement(host);
        expect(tokens).toEqual(row.tokens);

        // Arity and order are the identity, so the id must follow from them.
        expect(canonicalContentBlockJson(row.category, tokens)).toBe(row.canonical_json);
        expect(generateCustomId(row.category, tokens)).toBe(row.custom_id);
    });
});
