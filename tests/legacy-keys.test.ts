// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { createLegacyKeys, LegacyFormatError, type LegacyKeyFile } from '../src/legacy-keys.js';
import {
    convertLegacyCall,
    convertLegacyPluralForms,
    convertLegacyValue,
    SUPPORTED_LEGACY_FORMATS,
    type LegacyEntryPoint,
    type LegacyFormat,
} from '../src/legacy-value.js';
import { logger } from '../src/logger.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';
import * as pure from '../src/pure.js';
import * as main from '../src/index.js';
import vectors from './fixtures/mig-vectors.json';

/**
 * The MIG family against `mig-vectors.json`, which this repo authors for the
 * fleet. Rows in a format this core reads run here; rows in another core's
 * format are carried for that core, and their files are refused here.
 */

type Row = Record<string, unknown> & { id: string; format: string | null };
const doc = vectors as unknown as {
    core_formats: Record<string, string[]>;
    value_conversion: Array<Row & { value: string; expected: string; recognised: boolean }>;
    plural_forms: Array<Row & { forms: Record<string, string>; expected: string | null; recognised: boolean }>;
    calls: Array<Row & { entry_point: string; text: string | string[]; params: Record<string, unknown>; expected: string; recognised: boolean; same_phrase_as?: string }>;
    resolution: Array<Row & { files: LegacyKeyFile[]; key: string; category_arg?: string; expected: { phrase: string; category: string | null; file: string; recognised: boolean } | null }>;
    refusals: Array<{ id: string; file: LegacyKeyFile; format: string; hint?: string }>;
};

const JS = doc.core_formats.js!;
const ours = <T extends { format: string | null }>(rows: T[]) => rows.filter((r) => r.format !== null && JS.includes(r.format));
const JS_ENTRY_POINTS = ['t', 'vue-i18n', 'i18next'];

describe('the vector file', () => {
    it('is whole, and names the format on every row', () => {
        expect(doc.value_conversion).toHaveLength(27);
        expect(doc.plural_forms).toHaveLength(6);
        expect(doc.calls).toHaveLength(13);
        expect(doc.resolution).toHaveLength(18);
        expect(doc.refusals).toHaveLength(6);
        for (const row of [...doc.value_conversion, ...doc.plural_forms]) expect(row.format, row.id).toBeTruthy();
        for (const row of doc.calls.filter((c) => c.entry_point !== 't')) expect(row.format, row.id).toBeTruthy();
    });

    it("this core's set is the spec's JS set", () => {
        expect(JS).toEqual([...SUPPORTED_LEGACY_FORMATS]);
    });
});

describe('MIG-4: value conversion', () => {
    it.each(ours(doc.value_conversion).map((r) => [r.id, r] as const))('%s', (_id, row) => {
        const converted = convertLegacyValue(row.value, row.format as LegacyFormat);
        expect(converted.text).toBe(row.expected);
        expect(converted.recognised).toBe(row.recognised);
        if (!row.recognised) expect(converted.issue).toBeTruthy();
    });

    it('the same pipe string is a plural under vue-i18n and verbatim under plain', () => {
        const byId = Object.fromEntries(doc.value_conversion.map((r) => [r.id, r]));
        expect(byId['vue-two-forms']!.value).toBe(byId['plain-pipe-verbatim']!.value);
        expect(convertLegacyValue('car | cars', 'vue-i18n').text).toContain('plural');
        expect(convertLegacyValue('car | cars', 'plain').text).toBe('car | cars');
    });

    it('{count} never appears inside a converted branch', () => {
        const converted = [...ours(doc.value_conversion), ...ours(doc.plural_forms)]
            .filter((r) => r.recognised && String(r.expected).includes('plural'))
            .map((r) => ('value' in r ? convertLegacyValue(r.value as string, r.format as LegacyFormat) : convertLegacyPluralForms(r.forms as never)).text);
        expect(converted.length).toBeGreaterThanOrEqual(6);
        for (const text of converted) expect(text).not.toMatch(/\{(count|n)\}/);
    });

    it.each(ours(doc.plural_forms).map((r) => [r.id, r] as const))('plural forms: %s', (_id, row) => {
        const converted = convertLegacyPluralForms(row.forms as never);
        expect(converted.recognised).toBe(row.recognised);
        if (row.recognised) expect(converted.text).toBe(row.expected);
    });
});

describe('MIG-2: a literal miss converts by the entry point that received it', () => {
    const jsCalls = doc.calls.filter((c) => JS_ENTRY_POINTS.includes(c.entry_point));

    it('the JS entry points are all carried', () => {
        expect(new Set(jsCalls.map((c) => c.entry_point))).toEqual(new Set(JS_ENTRY_POINTS));
    });

    it.each(jsCalls.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        const converted = convertLegacyCall(row.text as string, row.entry_point as LegacyEntryPoint);
        expect(converted.text).toBe(row.expected);
        expect(converted.recognised).toBe(row.recognised);
    });

    it('every same_phrase_as pair names rows that register the identical phrase', () => {
        const byId = Object.fromEntries(doc.calls.map((c) => [c.id, c]));
        const pairs = doc.calls.filter((c) => c.same_phrase_as);
        expect(pairs.length).toBeGreaterThanOrEqual(4);
        for (const row of pairs) expect(row.expected, row.id).toBe(byId[row.same_phrase_as!]!.expected);
    });
});

describe('MIG-2, 3, 5, 7: resolution', () => {
    it.each(doc.resolution.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        const hit = createLegacyKeys(row.files).resolve(row.key);
        if (row.expected === null) {
            expect(hit).toBeNull();
            return;
        }
        expect(hit).not.toBeNull();
        expect({
            phrase: hit!.phrase,
            category: row.category_arg ?? hit!.category,
            file: hit!.file,
            recognised: hit!.recognised,
        }).toEqual(row.expected);
    });

    it('the first configured file answers, and the duplicate is reported', () => {
        const row = doc.resolution.find((r) => r.id === 'first-configured-file-wins')!;
        expect(createLegacyKeys(row.files).duplicates()).toEqual({ 'nav.home': ['app.json', 'vendor.json'] });
    });

    it('an unrecognised value is a problem naming the file and the key', () => {
        const row = doc.resolution.find((r) => r.id === 'undeclared-json-pipe-verbatim')!;
        const problems = createLegacyKeys(row.files).problems();
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ file: 'en.json', key: 'cart.count' });
    });

    it.each(doc.refusals.map((r) => [r.id, r] as const))('refused at load: %s', (_id, row) => {
        let error: unknown;
        try {
            createLegacyKeys([{ ...row.file, data: {} }]);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(LegacyFormatError);
        expect((error as Error).message).toContain(row.file.name);
        expect((error as Error).message).toContain(row.format);
        if (row.hint) expect((error as Error).message).toContain(row.hint);
    });

    it('control: a file in this core’s set is not refused', () => {
        for (const format of SUPPORTED_LEGACY_FORMATS) {
            expect(() => createLegacyKeys([{ name: 'en.json', format, data: {} }])).not.toThrow();
        }
        expect(() => createLegacyKeys([{ name: 'en.json', data: {} }])).not.toThrow();
    });
});

describe('the mode in t()', () => {
    const FILES: LegacyKeyFile[] = [
        { name: 'en.json', data: { checkout: { submit: 'Pay now', greet: 'Hello {{name}}' }, cart: { count: 'car | cars' } } },
    ];
    let tr: Translations;
    const queued = () => (tr as unknown as { missingTokens: Array<{ token: string; category: string }> }).missingTokens;
    const t = (...args: unknown[]) => (tr.t as unknown as (...a: unknown[]) => string)(...args);

    beforeEach(() => {
        tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' });
        sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
        currentlyLoadedLocale.set('en');
        writeEnabled.set(true);
        tr.settle();
        queued().length = 0;
    });

    afterEach(() => {
        writeEnabled.set(undefined);
        logger.debugEnabled = false;
        vi.restoreAllMocks();
    });

    it('MIG-1: unset, t() does no key lookup: the key is the phrase', () => {
        // Nothing has configured the mode on this instance, so a key-shaped
        // argument is literal source text: no file was consulted.
        expect(t('checkout.submit')).toBe('checkout.submit');
        expect(queued().map((q) => q.token)).toEqual(['checkout.submit']);
    });

    it('MIG-1: set, the same call resolves the key', () => {
        tr.setLegacyKeys(FILES);
        expect(t('checkout.submit')).toBe('Pay now');
    });

    it('MIG-3 and MIG-5: a hit registers the value under the key’s namespace, never the key', () => {
        tr.setLegacyKeys(FILES);
        t('checkout.submit');
        expect(queued().map((q) => [q.category, q.token])).toEqual([['checkout', 'Pay now']]);
    });

    it('MIG-5: an explicit category wins', () => {
        tr.setLegacyKeys(FILES);
        t('checkout.submit', 'Buttons');
        expect(queued().map((q) => [q.category, q.token])).toEqual([['Buttons', 'Pay now']]);
    });

    it('MIG-3: registering through a key equals passing the resolved text directly', () => {
        tr.setLegacyKeys(FILES);
        t('checkout.greet', { name: 'Ada' });
        const viaKey = queued().map((q) => [q.category, q.token]);
        queued().length = 0;
        tr.setLegacyKeys(null);
        t('Hello {name}', 'checkout', { name: 'Ada' });
        expect(queued().map((q) => [q.category, q.token])).toEqual(viaKey);
    });

    it('params reach the converted placeholder', () => {
        tr.setLegacyKeys(FILES);
        expect(t('checkout.greet', { name: 'Ada' })).toBe('Hello Ada');
    });

    it('MIG-2 and MIG-6: a miss registers its argument as literal text and warns at debug', () => {
        tr.setLegacyKeys(FILES);
        logger.debugEnabled = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(t('checkout.sumbit')).toBe('checkout.sumbit');
        expect(queued().map((q) => q.token)).toEqual(['checkout.sumbit']);
        expect(warn.mock.calls.flat().join(' ')).toContain('checkout.sumbit');
    });

    it('control: with debug off, the miss is silent', () => {
        tr.setLegacyKeys(FILES);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        t('checkout.sumbit');
        expect(warn).not.toHaveBeenCalled();
    });

    it('MIG-4: an unrecognised value registers as written and warns at every level, once, naming file and key', () => {
        tr.setLegacyKeys(FILES);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        t('cart.count');
        t('cart.count');
        expect(queued().map((q) => q.token)).toEqual(['car | cars']);
        expect(warn).toHaveBeenCalledTimes(1);
        const text = warn.mock.calls.flat().join(' ');
        expect(text).toContain('en.json');
        expect(text).toContain('cart.count');
    });

    it('MIG-6: a changed value is simply a new phrase', () => {
        tr.setLegacyKeys([{ name: 'en.json', data: { cta: { buy: 'Buy now' } } }]);
        t('cta.buy');
        tr.setLegacyKeys([{ name: 'en.json', data: { cta: { buy: 'Buy it now' } } }]);
        t('cta.buy');
        expect(queued().map((q) => q.token)).toEqual(['Buy now', 'Buy it now']);
    });

    it('MIG-7: init refuses a file this core does not read, naming format and file', async () => {
        await expect(
            LangsysApp.init({
                projectid: 'p',
                key: 'k',
                UserLocaleStore: createSignal('en'),
                legacyKeys: [{ name: 'lang/en/messages.php', data: {} }],
            })
        ).rejects.toThrow(/laravel.*lang\/en\/messages\.php|lang\/en\/messages\.php.*laravel/);
    });
});

describe('MIG-8: one converter for every JS entry point', () => {
    it('the conversion and the resolver are on /pure and the main entry, as the same objects', () => {
        for (const name of ['convertLegacyValue', 'convertLegacyPluralForms', 'convertLegacyCall', 'createLegacyKeys', 'LegacyFormatError', 'SUPPORTED_LEGACY_FORMATS'] as const) {
            expect((pure as Record<string, unknown>)[name], name).toBeDefined();
            expect((pure as Record<string, unknown>)[name], name).toBe((main as Record<string, unknown>)[name]);
        }
    });

    it('the browser t() mode reads the same configuration through the same resolver', () => {
        const files: LegacyKeyFile[] = [{ name: 'en.json', format: 'vue-i18n', data: { cart: { count: 'car | cars' } } }];
        const tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' });
        tr.setLegacyKeys(files);
        writeEnabled.set(true);
        tr.settle();
        (tr.t as unknown as (k: string, p: object) => string)('cart.count', { count: 2 });
        const queuedTokens = (tr as unknown as { missingTokens: Array<{ token: string }> }).missingTokens.map((q) => q.token);
        expect(queuedTokens).toEqual([createLegacyKeys(files).resolve('cart.count')!.phrase]);
        writeEnabled.set(undefined);
    });
});
