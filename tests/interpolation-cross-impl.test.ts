import { beforeEach, describe, expect, it } from 'vitest';
import { interpolate } from '../src/interpolate.js';
import { canonicalizeLocale } from '../src/locale.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import { Translations } from '../src/translations.js';
import fixture from './fixtures/interpolation-reference.json';

/**
 * Cross-implementation assertion for interpolation, against langsys-php's
 * shared fixture. Vendored from `langsys-php-sdk` @ `c11a711`,
 * `tests/fixtures/interpolation-reference.json`, blob `017bffdd1d83`.
 *
 * This is what takes ICU-1..6 off in-repo-only evidence. The recovery rules —
 * `other`-branch selection, null-as-missing, `#` → `{argName}`, and the
 * recovered literal surviving the formatter — were previously proven only by
 * tests I wrote against code I wrote. Agreement with a PHP implementation of
 * the same rules excludes the shared-mistake class.
 *
 * `requires_intl` marks rows PHP can only satisfy with its intl extension
 * present. JavaScript always has the formatter, so every row is asserted here
 * — the flag is recorded rather than used to skip.
 *
 * Four rows call a select and a plural with no params: two omit the
 * `params` key, and two pass an empty map. Where a row omits `params` the harness
 * omits the argument, so the case exercised is the missing argument itself, not
 * an empty map standing in for it. Every row also runs through `t()`, because
 * that is where the no-params failure lived: `t()` skipped `interpolate` entirely
 * without params, which a harness calling `interpolate` alone could never see.
 */

interface Row {
    description: string;
    template: string;
    params?: Record<string, unknown>;
    locale: string;
    expected: string;
    requires_intl: boolean;
}

const rows = fixture as unknown as Row[];
const hasParams = (row: Row) => Object.prototype.hasOwnProperty.call(row, 'params');

describe('interpolation agrees with langsys-php', () => {
    it('vendored the whole fixture', () => {
        expect(rows).toHaveLength(25);
    });

    it('asserts every row, including the ones PHP gates on its intl extension', () => {
        // Recorded rather than used to skip: a JS run that silently skipped the
        // intl rows would report agreement it had not tested.
        expect(rows.filter((r) => r.requires_intl).length).toBeGreaterThan(0);
    });

    it('carries rows that omit params and rows with an empty map, so both shapes are exercised', () => {
        expect(rows.filter((r) => !hasParams(r)).length).toBeGreaterThanOrEqual(2);
        expect(rows.filter((r) => hasParams(r) && Object.keys(r.params ?? {}).length === 0).length).toBeGreaterThanOrEqual(2);
    });

    it.each(rows.map((r) => [r.description, r] as const))('%s', (_d, row) => {
        const rendered = hasParams(row)
            ? interpolate(row.template, row.params, row.locale)
            : interpolate(row.template, undefined, row.locale);
        expect(rendered).toBe(row.expected);
    });
});

describe('the same rows through t(), where the no-params case failed', () => {
    type LooseT = (phrase: string, params?: Record<string, unknown>) => string;
    let t: LooseT;

    beforeEach(() => {
        sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
        t = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' }).t as unknown as LooseT;
    });

    it.each(rows.map((r) => [r.description, r] as const))('%s', (_d, row) => {
        currentlyLoadedLocale.set(canonicalizeLocale(row.locale));
        const rendered = hasParams(row) ? t(row.template, row.params) : t(row.template);
        expect(rendered).toBe(row.expected);
    });
});
