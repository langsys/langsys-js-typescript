import { describe, expect, it } from 'vitest';
import { interpolate } from '../src/interpolate.js';
import fixture from './fixtures/interpolation-reference.json';

/**
 * Cross-implementation assertion for interpolation, against langsys-php's
 * shared fixture. Vendored from `langsys-php-sdk` @ `5fa4d48`,
 * `tests/fixtures/interpolation-reference.json`, blob `d369bd185ca2`.
 *
 * This is what takes ICU-1..5 off in-repo-only evidence. The recovery rules —
 * `other`-branch selection, null-as-missing, `#` → `{argName}`, and the
 * recovered literal surviving the formatter — were previously proven only by
 * tests I wrote against code I wrote. Agreement with a PHP implementation of
 * the same rules excludes the shared-mistake class.
 *
 * `requires_intl` marks rows PHP can only satisfy with its intl extension
 * present. JavaScript always has the formatter, so every row is asserted here
 * — the flag is recorded rather than used to skip.
 */

interface Row {
    description: string;
    template: string;
    params: Record<string, unknown>;
    locale: string;
    expected: string;
    requires_intl: boolean;
}

const rows = fixture as unknown as Row[];

describe('interpolation agrees with langsys-php', () => {
    it('vendored the whole fixture', () => {
        expect(rows).toHaveLength(19);
    });

    it('asserts every row, including the ones PHP gates on its intl extension', () => {
        // Recorded rather than used to skip: a JS run that silently skipped the
        // intl rows would report agreement it had not tested.
        expect(rows.filter((r) => r.requires_intl).length).toBeGreaterThan(0);
    });

    it.each(rows.map((r) => [r.description, r] as const))('%s', (_d, row) => {
        expect(interpolate(row.template, row.params as never, row.locale)).toBe(row.expected);
    });
});
