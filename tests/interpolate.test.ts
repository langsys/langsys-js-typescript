import { describe, expect, it } from 'vitest';
import { interpolate, isICU } from '../src/interpolate.js';

describe('isICU', () => {
    it('detects plural', () => {
        expect(isICU('{n, plural, one {# review} other {# reviews}}')).toBe(true);
    });

    it('detects select (gender)', () => {
        expect(isICU('{g, select, male {él} female {ella} other {ellos}}')).toBe(true);
    });

    it('detects selectordinal, number, date, time', () => {
        expect(isICU('{n, selectordinal, one {1st} other {#th}}')).toBe(true);
        expect(isICU('{n, number, ::compact-short}')).toBe(true);
        expect(isICU('{d, date, short}')).toBe(true);
        expect(isICU('{t, time, short}')).toBe(true);
    });

    it('does not detect simple interpolation', () => {
        expect(isICU('Hello, {name}!')).toBe(false);
        expect(isICU('{count} items in your cart')).toBe(false);
        expect(isICU('plain text with no slots')).toBe(false);
    });

    it('tolerates the ICU keyword appearing as text only', () => {
        // No comma after the keyword → not ICU shape.
        expect(isICU('something plural here {n}')).toBe(false);
    });

    it('detects ICU mixed with regular text', () => {
        expect(isICU('Hello {name}, {n, plural, one {1 alert} other {# alerts}}')).toBe(true);
    });
});

describe('interpolate — simple {name} path', () => {
    it('substitutes a single placeholder', () => {
        expect(interpolate('Hello, {name}!', { name: 'X' })).toBe('Hello, X!');
    });

    it('substitutes multiple placeholders', () => {
        expect(interpolate('Hi {first} {last}', { first: 'A', last: 'B' })).toBe('Hi A B');
    });

    it('leaves unknown placeholders untouched (visible to dev)', () => {
        expect(interpolate('Hello, {name}!', {})).toBe('Hello, {name}!');
    });

    it('leaves null/undefined values untouched', () => {
        expect(interpolate('Hello, {name}!', { name: null })).toBe('Hello, {name}!');
        expect(interpolate('Hello, {name}!', { name: undefined })).toBe('Hello, {name}!');
    });

    it('coerces non-string values via String()', () => {
        expect(interpolate('Count: {n}', { n: 42 })).toBe('Count: 42');
        expect(interpolate('On: {b}', { b: true })).toBe('On: true');
    });

    it('serializes Date values as ISO 8601', () => {
        const d = new Date('2026-05-27T00:00:00.000Z');
        expect(interpolate('When: {d}', { d })).toBe('When: 2026-05-27T00:00:00.000Z');
    });

    it('trims keys with whitespace', () => {
        expect(interpolate('Hello, { name }!', { name: 'X' })).toBe('Hello, X!');
    });
});

describe('interpolate — ICU plural path', () => {
    it('renders en plural one/other correctly', () => {
        const tpl = '{n, plural, one {Based on # review} other {Based on # reviews}}';
        expect(interpolate(tpl, { n: 1 }, 'en')).toBe('Based on 1 review');
        expect(interpolate(tpl, { n: 5 }, 'en')).toBe('Based on 5 reviews');
        expect(interpolate(tpl, { n: 0 }, 'en')).toBe('Based on 0 reviews');
    });

    it('renders es-es plural one/other correctly', () => {
        const tpl = '{n, plural, one {Basado en # reseña} other {Basado en # reseñas}}';
        expect(interpolate(tpl, { n: 1 }, 'es-es')).toBe('Basado en 1 reseña');
        expect(interpolate(tpl, { n: 5 }, 'es-es')).toBe('Basado en 5 reseñas');
    });

    it('honors ar-sa six-category plural rules', () => {
        // Arabic distinguishes zero/one/two/few/many/other. Distinct branches:
        const tpl =
            '{n, plural, zero {zero-branch} one {one-branch} two {two-branch} few {few-branch} many {many-branch} other {other-branch}}';
        expect(interpolate(tpl, { n: 0 }, 'ar-sa')).toBe('zero-branch');
        expect(interpolate(tpl, { n: 1 }, 'ar-sa')).toBe('one-branch');
        expect(interpolate(tpl, { n: 2 }, 'ar-sa')).toBe('two-branch');
        // few: 3-10 are "few" in Arabic
        expect(interpolate(tpl, { n: 3 }, 'ar-sa')).toBe('few-branch');
        expect(interpolate(tpl, { n: 11 }, 'ar-sa')).toBe('many-branch');
    });

    it('falls back to other for missing categories', () => {
        const tpl = '{n, plural, other {fallback #}}';
        expect(interpolate(tpl, { n: 1 }, 'en')).toBe('fallback 1');
        expect(interpolate(tpl, { n: 100 }, 'en')).toBe('fallback 100');
    });
});

describe('interpolate — ICU select (gender)', () => {
    it('selects the matching branch', () => {
        const tpl = '{g, select, male {Él} female {Ella} other {Elles}}';
        expect(interpolate(tpl, { g: 'male' }, 'es-es')).toBe('Él');
        expect(interpolate(tpl, { g: 'female' }, 'es-es')).toBe('Ella');
        expect(interpolate(tpl, { g: 'nonbinary' }, 'es-es')).toBe('Elles');
    });
});

describe('interpolate — mixed ICU + simple slots', () => {
    it('routes the whole template through ICU when ICU syntax is present', () => {
        // IntlMessageFormat handles {name} alongside ICU constructs natively.
        const tpl = 'Hello {name}, {n, plural, one {1 alert} other {# alerts}}';
        expect(interpolate(tpl, { name: 'Sarah', n: 1 }, 'en')).toBe('Hello Sarah, 1 alert');
        expect(interpolate(tpl, { name: 'Sarah', n: 5 }, 'en')).toBe('Hello Sarah, 5 alerts');
    });
});

describe('interpolate — malformed ICU fallback', () => {
    it('falls back to simple interpolation on parse failure (no throw)', () => {
        // Missing closing branch — IntlMessageFormat constructor throws.
        // Our fallback should silently route through simpleInterpolate so the
        // developer sees a broken-but-visible string rather than a runtime
        // crash. simpleInterpolate won't substitute `{n` (no closing brace)
        // so the original template is returned mostly intact.
        const malformed = '{n, plural, one {one #}';
        expect(() => interpolate(malformed, { n: 1 }, 'en')).not.toThrow();
    });

    it('does not consume ICU-shaped slots in fallback', () => {
        // simpleInterpolate's regex excludes `,` from key chars so malformed
        // ICU content doesn't get incorrectly substituted.
        const malformed = '{n, plural, one {one #}';
        const out = interpolate(malformed, { n: 1 }, 'en');
        expect(out).toBe(malformed);
    });
});
