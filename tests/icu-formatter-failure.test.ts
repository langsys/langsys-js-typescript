// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ICU-6: a formatter failure renders through the SDK's own branch selection, and
 * warns at every log level, deduplicated per (template, locale).
 *
 * `intl-messageformat` renders the spec's vector natively, so the vector rows pass
 * directly. The fallback is proved with a FORCED formatter failure: the module is
 * wrapped so `format()` throws while `failure.force` is set. Parsing still works, as it
 * does in the real failure the rule describes (a phrase that parses and then fails to
 * format), so the SDK has an AST to select branches from.
 */

const failure = vi.hoisted(() => ({ force: false }));

vi.mock('intl-messageformat', async (importOriginal) => {
    const real = await importOriginal<typeof import('intl-messageformat')>();
    // `format` is an instance property on IntlMessageFormat, not a prototype
    // method, so it is wrapped per instance.
    class FailingFormat extends real.IntlMessageFormat {
        constructor(...args: ConstructorParameters<typeof real.IntlMessageFormat>) {
            super(...args);
            const format = this.format;
            this.format = ((...values: Parameters<typeof format>) => {
                if (failure.force) throw new Error('FORCED_FORMATTER_FAILURE');
                return format(...values);
            }) as typeof format;
        }
    }
    return { ...real, IntlMessageFormat: FailingFormat, default: FailingFormat };
});

const { interpolate } = await import('../src/interpolate.js');
const { logger } = await import('../src/logger.js');
const { createSignal } = await import('../src/signal.js');
const { config: configStore, currentlyLoadedLocale, sTranslations } = await import('../src/stores.js');
const { Translations } = await import('../src/translations.js');

const VECTOR = 'You have {count, plural, one {{count} car} other {{count} cars}}';

type LooseT = (phrase: string, category?: string, params?: Record<string, unknown>) => string;
const looseT = () =>
    new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' }).t as unknown as LooseT;

let warn: ReturnType<typeof vi.spyOn>;
let seq = 0;
/** A fresh template per test, so the dedupe set carries nothing between tests. */
const fresh = (template: string) => `${template} [${++seq}]`;

beforeEach(() => {
    failure.force = false;
    logger.debugEnabled = false;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI' },
    } as never);
    currentlyLoadedLocale.set(configStore.baseLocale);
});

afterEach(() => {
    failure.force = false;
    warn.mockRestore();
});

const warnings = () => warn.mock.calls.map((args: unknown[]) => args.map(String).join(' '));

describe('the shared vector renders on this SDK', () => {
    it.each([
        [3, 'You have 3 cars'],
        [1, 'You have 1 car'],
    ])('natively: count %d', (count, expected) => {
        expect(interpolate(VECTOR, { count }, 'en')).toBe(expected);
        expect(looseT()(VECTOR, 'UI', { count })).toBe(expected);
        expect(warnings()).toEqual([]);
    });

    it.each([
        [3, 'You have 3 cars'],
        [1, 'You have 1 car'],
    ])('through the fallback when the formatter fails: count %d', (count, expected) => {
        failure.force = true;
        expect(interpolate(VECTOR, { count }, 'en')).toBe(expected);
        expect(looseT()(VECTOR, 'UI', { count })).toBe(expected);
    });
});

describe('the warning', () => {
    it('fires with debug logging off, naming the phrase, the locale and the error', () => {
        failure.force = true;
        const template = fresh(VECTOR);
        interpolate(template, { count: 3 }, 'en');
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain(JSON.stringify(template));
        expect(warnings()[0]).toContain("'en'");
        expect(warnings()[0]).toContain('FORCED_FORMATTER_FAILURE');
    });

    it('is deduplicated per (template, locale)', () => {
        failure.force = true;
        const template = fresh(VECTOR);
        interpolate(template, { count: 3 }, 'en');
        interpolate(template, { count: 1 }, 'en');
        expect(warnings()).toHaveLength(1);
        interpolate(template, { count: 3 }, 'fr');
        expect(warnings()).toHaveLength(2);
    });

    it('onFormatterFailure receives the error, template and locale on every call, and the core logger stays silent', () => {
        failure.force = true;
        const template = fresh(VECTOR);
        const calls: unknown[][] = [];
        for (let i = 0; i < 2; i++) {
            expect(interpolate(template, { count: 3 }, 'en', { onFormatterFailure: (...args) => calls.push(args) })).toMatch(/^You have 3 cars /);
        }
        expect(calls).toHaveLength(2);
        expect(String(calls[0]![0])).toContain('FORCED_FORMATTER_FAILURE');
        expect(calls[0]!.slice(1)).toEqual([template, 'en']);
        expect(warnings()).toEqual([]);
    });

    it('control: a missing argument the formatter recovers from is NOT this warning', () => {
        interpolate(fresh('{g, select, male {He} other {They}} left'), {}, 'en');
        expect(warnings()).toEqual([]);
    });
});

describe('branch selection without the formatter', () => {
    beforeEach(() => {
        failure.force = true;
    });

    const RU = '{n, plural, =0 {none} one {# one} few {# few} many {# many} other {# other}}';

    it('an exact =N wins over the CLDR category', () => {
        expect(interpolate(fresh(RU), { n: 0 }, 'ru')).toMatch(/^none /);
    });

    it("then the value's CLDR category in the render locale", () => {
        expect(interpolate(RU, { n: 3 }, 'ru')).toBe('3 few');
        expect(interpolate(RU, { n: 5 }, 'ru')).toBe('5 many');
        expect(interpolate(RU, { n: 21 }, 'ru')).toBe('21 one');
    });

    it('else other', () => {
        expect(interpolate('{n, plural, one {# one} other {# other}}', { n: 3 }, 'ru')).toBe('3 other');
    });

    it('# renders the value after the offset, and =N matches before it', () => {
        const OFFSET = '{n, plural, offset:1 =1 {just you} one {you and # other} other {you and # others}}';
        expect(interpolate(OFFSET, { n: 1 }, 'en')).toBe('just you');
        expect(interpolate(OFFSET, { n: 2 }, 'en')).toBe('you and 1 other');
        expect(interpolate(OFFSET, { n: 4 }, 'en')).toBe('you and 3 others');
    });

    it('a select takes the matching branch, else other', () => {
        const SELECT = '{g, select, female {She} other {They}} left';
        expect(interpolate(SELECT, { g: 'female' }, 'en')).toBe('She left');
        expect(interpolate(SELECT, { g: 'x' }, 'en')).toBe('They left');
    });

    it('supplied values are filled with CLDR number formatting', () => {
        expect(interpolate('{name} owes {amount, number}', { name: 'Ada', amount: 1234.5 }, 'de')).toBe('Ada owes 1.234,5');
    });

    it('an unsupplied value stays visible as {argName}, in a plural too', () => {
        expect(interpolate('{name} has {count, plural, one {# car} other {# cars}}', {}, 'en')).toBe('{name} has {count} cars');
    });

    it('nested constructs select at every level', () => {
        const NESTED = '{g, select, female {{n, plural, one {She has # car} other {She has # cars}}} other {They have {n} cars}}';
        expect(interpolate(NESTED, { g: 'female', n: 1 }, 'en')).toBe('She has 1 car');
        expect(interpolate(NESTED, { g: 'female', n: 2 }, 'en')).toBe('She has 2 cars');
        expect(interpolate(NESTED, { g: 'x', n: 2 }, 'en')).toBe('They have 2 cars');
    });

    it('never renders "" nor the raw construct', () => {
        for (const count of [0, 1, 2, 5]) {
            const out = interpolate(VECTOR, { count }, 'en');
            expect(out).not.toBe('');
            expect(out).not.toContain('plural');
            expect(out).not.toContain('{count}');
        }
    });
});
