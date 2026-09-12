import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NON_TRANSLATABLE_ELEMENTS } from '../src/identity.js';
import * as pure from '../src/pure.js';

/**
 * The CHANGELOG must at least NAME every element we exclude and every symbol
 * `/pure` exports.
 *
 * WHY THIS EXISTS, and it is not tidiness. The CHANGELOG is the only one of our
 * documents written for people outside this repo, and it is therefore the one
 * least likely to be re-derived — so it is the one that goes stale first and the
 * staleness is the most expensive. Measured: when `<math>` joined the exclusion
 * list, the rule row in CONFORMANCE was updated, the tests were updated, the
 * fixture gained two rows, and the CHANGELOG still said four elements. That
 * omission is an **id-changing** behaviour change a consumer had no way to learn
 * about from the document they actually read. `/pure`'s list was two exports
 * behind for the same reason.
 *
 * The PHP lane hit the identical failure one layer out and named it well: a
 * staleness check that does not cover the document most likely to go stale,
 * because that document is the one written for people who will not re-derive it.
 * Their release gate was still describing a hazard their own branch had fixed.
 *
 * SCOPE, STATED HONESTLY: this is a COMPLETENESS check, not a correctness one. It
 * proves a name is mentioned; it cannot prove the sentence around it is true. It
 * catches the failure that actually happened twice — a name added to the code and
 * never to the CHANGELOG — and nothing more. A test that claimed to verify the
 * prose would be a test nobody could keep green.
 *
 * Deliberately scanning the WHOLE file rather than the Unreleased section. The
 * section-scoped version is tighter and breaks the moment a release is cut: the
 * names move into the released section and a fresh empty Unreleased heading
 * appears, so it would fail for a reason that has nothing to do with the thing
 * being checked. A check that goes red on every release gets deleted.
 */

const CHANGELOG = readFileSync(join(process.cwd(), 'CHANGELOG.md'), 'utf8');

/** Names are required in backticks, which is how this file refers to code. */
function mentions(token: string): boolean {
    return CHANGELOG.includes('`' + token + '`');
}

describe('the CHANGELOG names every excluded element', () => {
    it('has something to check', () => {
        // Guard against the vacuous pass: an empty list would satisfy every
        // assertion below without reading anything.
        expect(NON_TRANSLATABLE_ELEMENTS.length).toBeGreaterThanOrEqual(5);
        expect(CHANGELOG.length).toBeGreaterThan(5000);
    });

    it.each(NON_TRANSLATABLE_ELEMENTS)('`<%s>` is documented', (element) => {
        // The angle-bracket form specifically. Bare `template` and `math` would
        // collide with ordinary prose; `<template>` does not.
        expect(
            mentions(`<${element}>`),
            `The CHANGELOG never mentions \`<${element}>\`. It is in NON_TRANSLATABLE_ELEMENTS, so ` +
                `excluding it MOVED custom_id for every block containing one — which is exactly the kind of ` +
                `change a consumer can only learn about from this file.`
        ).toBe(true);
    });

    it('and names <svg> as the deliberate non-exclusion', () => {
        // The absence is part of the contract: a reader who sees four code-bearing
        // elements excluded will reasonably assume svg is among them.
        expect(mentions('<svg>')).toBe(true);
        expect(NON_TRANSLATABLE_ELEMENTS).not.toContain('svg');
    });
});

describe('the CHANGELOG names every /pure export', () => {
    const exported = Object.keys(pure).sort();

    it('has something to check', () => {
        expect(exported.length).toBeGreaterThanOrEqual(22);
    });

    it.each(Object.keys(pure).sort())('`%s` is documented', (name) => {
        expect(
            mentions(name),
            `The CHANGELOG never mentions \`${name}\`, which /pure exports. The subpath exists so other ` +
                `SDKs can import these instead of reimplementing them, and they find out what is available ` +
                `from this file.`
        ).toBe(true);
    });
});

describe('the check can actually fail', () => {
    // Without this, every assertion above could be a `mentions()` that always
    // returns true. Both halves: a name that is present, and one that cannot be.
    it('finds a name that is there and not one that is not', () => {
        expect(mentions('generateCustomId')).toBe(true);
        expect(mentions('definitelyNotASymbolInThisProject')).toBe(false);
    });

    it('requires the backticks, so prose coincidence is not a pass', () => {
        // "math" appears in ordinary English; `<math>` does not.
        expect(CHANGELOG.includes('math')).toBe(true);
        expect(mentions('notAFencedName')).toBe(false);
    });
});
