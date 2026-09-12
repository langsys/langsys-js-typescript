// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { canonicalContentBlockJson, generateCustomId, tokenizeElement } from '../src/content-block.js';
import fixture from './fixtures/tokenizer-reference.json';

/**
 * Cross-implementation assertion for the tokenizer, against langsys-php's
 * shared fixture. Vendored from `langsys-php-sdk` @ `ba9fb7b`,
 * `tests/fixtures/tokenizer-reference.json`, blob `5689f3c1425502f3a2c4afd4b48e9bdbfc25a32d`.
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
 * There are no overrides, and that is the end of a story worth keeping.
 *
 * This file briefly carried one. `tokenizer-reference.json` had a row named
 * "script and style contents are never harvested" whose expected tokens were
 * `["Keep", "var a=1;", ".a{}"]` — the name stated the intent and the data
 * recorded the bug, so the row locked in the behaviour it was named for
 * preventing, and both SDKs matched the data and sent CSS and JavaScript to
 * machine translation.
 *
 * The override held our corrected expectation without editing a vendored file,
 * and a second test asserted it still DISAGREED with the fixture — so that when
 * PHP re-derived the row, the override would fail and have to be deleted rather
 * than quietly outliving its reason. PHP corrected it (`ba9fb7b`, blob
 * `5689f3c1`, note "CORRECTED 2026-09-11"), the disagreement test went red with
 * "delete this override", and this is that deletion.
 */

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
