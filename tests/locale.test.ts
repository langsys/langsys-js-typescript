import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeLocale, maximizedLangScript } from '../src/locale.js';
import { LangsysApp } from '../src/langsys-app.js';
import { logger } from '../src/logger.js';

describe('canonicalizeLocale', () => {
    it('normalises casing to the internal lowercase form', () => {
        expect(canonicalizeLocale('en-us')).toBe('en-us');
        expect(canonicalizeLocale('EN-US')).toBe('en-us');
        expect(canonicalizeLocale('zh-hant-tw')).toBe('zh-hant-tw');
        expect(canonicalizeLocale('sr-cyrl-rs')).toBe('sr-cyrl-rs');
    });

    it('accepts underscore separators', () => {
        expect(canonicalizeLocale('en_US')).toBe('en-us');
        expect(canonicalizeLocale('zh_hant_tw')).toBe('zh-hant-tw');
    });

    it('resolves legacy language aliases', () => {
        expect(canonicalizeLocale('iw')).toBe('he');
        expect(canonicalizeLocale('in')).toBe('id');
    });

    it('keeps variants and extensions as written, lowercased', () => {
        // The API's codes are ICU locale ids, which keep a variant as a variant. BCP 47
        // canonicalisation turns POSIX into the extension -u-va-posix, a code the API
        // does not hold.
        expect(canonicalizeLocale('en-US-POSIX')).toBe('en-us-posix');
        expect(canonicalizeLocale('en_US_POSIX')).toBe('en-us-posix');
        expect(canonicalizeLocale('ca-ES-VALENCIA')).toBe('ca-es-valencia');
        expect(canonicalizeLocale('en-US-u-ca-gregory')).toBe('en-us-u-ca-gregory');
        expect(canonicalizeLocale('EN-us-X-foo')).toBe('en-us-x-foo');
    });

    it('resolves aliases in the language, script and region ahead of a variant', () => {
        expect(canonicalizeLocale('iw-IL-POSIX')).toBe('he-il-posix');
        expect(canonicalizeLocale('sh-BA')).toBe('sr-latn-ba');
        // The script written is kept: sh's alias supplies Latn only when none is.
        expect(canonicalizeLocale('sh-Cyrl-BA')).toBe('sr-cyrl-ba');
        expect(canonicalizeLocale('de-DD-1996')).toBe('de-de-1996');
        expect(canonicalizeLocale('cmn-Hans')).toBe('zh-hans');
    });

    it('leaves bare language codes alone', () => {
        expect(canonicalizeLocale('en')).toBe('en');
        expect(canonicalizeLocale('ES')).toBe('es');
    });

    it('trims whitespace', () => {
        expect(canonicalizeLocale(' en-us ')).toBe('en-us');
    });

    it('passes through empty/invalid input without throwing', () => {
        expect(canonicalizeLocale('')).toBe('');
        expect(() => canonicalizeLocale('!!not-a-tag!!')).not.toThrow();
    });

    it('warns under debug about an invalid tag, one with a valid language included', () => {
        const wasDebug = logger.debugEnabled;
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        logger.debugEnabled = true;
        try {
            expect(canonicalizeLocale('en-US-!!')).toBe('en-us-!!');
            expect(spy.mock.calls.flat().join(' ')).toContain('"en-US-!!" is not a valid BCP 47 locale tag');
            spy.mockClear();
            expect(canonicalizeLocale('en-US-POSIX')).toBe('en-us-posix');
            expect(spy).not.toHaveBeenCalled();
        } finally {
            logger.debugEnabled = wasDebug;
            spy.mockRestore();
        }
    });
});

describe('maximizedLangScript', () => {
    it('infers script via CLDR likely subtags', () => {
        expect(maximizedLangScript('zh')).toBe('zh-hans');
        expect(maximizedLangScript('zh-CN')).toBe('zh-hans');
        expect(maximizedLangScript('zh-TW')).toBe('zh-hant');
        expect(maximizedLangScript('zh-Hant-TW')).toBe('zh-hant');
        expect(maximizedLangScript('sr')).toBe('sr-cyrl');
        expect(maximizedLangScript('es-MX')).toBe('es-latn');
    });

    it('returns null for unparseable tags', () => {
        expect(maximizedLangScript('!!')).toBeNull();
    });
});

describe('LangsysApp.detectPreferredLocale — CLDR matching', () => {
    it('returns exact matches after normalisation', () => {
        expect(LangsysApp.detectPreferredLocale('en-us', ['en-US', 'fr-FR'])).toBe('en-us');
    });

    it('normalises supported-locale casing too', () => {
        expect(LangsysApp.detectPreferredLocale('en-US', ['en-us'])).toBe('en-us');
    });

    it('matches language+script with region ignored (es-MX → es-ES)', () => {
        expect(LangsysApp.detectPreferredLocale('es-MX', ['es-ES', 'en-US'])).toBe('es-es');
    });

    it('falls back from regional to bare language (es-ES → es)', () => {
        expect(LangsysApp.detectPreferredLocale('es-ES', ['es', 'en'])).toBe('es');
    });

    it('matches zh-Hans-CN to a bare zh catalog (zh likely-script is Hans)', () => {
        expect(LangsysApp.detectPreferredLocale('zh-Hans-CN', ['zh', 'en'])).toBe('zh');
    });

    it('matches zh-TW to zh-Hant, not zh-Hans', () => {
        expect(LangsysApp.detectPreferredLocale('zh-TW', ['zh-Hans', 'zh-Hant'])).toBe('zh-hant');
    });

    it('never serves a Simplified catalog to a Traditional reader', () => {
        // The guarantee is unchanged and now stronger. It used to fall through
        // to the user's own first preference, which is script-safe but is not
        // in the supported list — so the caller fetched a `zh-hant-tw` catalog
        // that does not exist. Returning false hands the decision back, and
        // their `|| 'en-us'` default is a catalog they actually have.
        expect(LangsysApp.detectPreferredLocale('zh-Hant-TW', ['zh-Hans', 'zh'])).toBe(false);
    });

    it('respects Accept-Language q-value ordering', () => {
        expect(LangsysApp.detectPreferredLocale('fr;q=0.8, en-US;q=0.9', ['fr-FR', 'en-US'])).toBe('en-us');
    });

    it('returns false when nothing in the supported list matches', () => {
        // Contract change, deliberate: this returned 'pt-br' — a locale the
        // caller had just said it does not support. The documented
        // `detectPreferredLocale(header, supported) || 'en-us'` idiom could
        // therefore never reach its default.
        expect(LangsysApp.detectPreferredLocale('pt-br', ['ja-JP'])).toBe(false);
        // Without a supported list the first-preference behaviour is unchanged.
        expect(LangsysApp.detectPreferredLocale('pt-br')).toBe('pt-br');
    });
});

describe('WIRE-3: the internal form is lowercase, and it is the wire form', () => {
    it('normalises to lowercase xx-yy, including script subtags', () => {
        // The backend stores every locale lowercase — script subtags included
        // (az-cyrl, bs-latn) — and its request middleware lowercases. Sending
        // that form is what makes the SDK independent of a normalisation it
        // cannot see, on routes that may not mount it.
        expect(canonicalizeLocale('en-US')).toBe('en-us');
        expect(canonicalizeLocale('zh-Hant-TW')).toBe('zh-hant-tw');
        expect(canonicalizeLocale('az-Cyrl')).toBe('az-cyrl');
    });

    it('still resolves legacy aliases before flattening case', () => {
        // Lowercasing first would lose these: the alias table is keyed on
        // canonical tags.
        expect(canonicalizeLocale('iw')).toBe('he');
        expect(canonicalizeLocale('in-ID')).toBe('id-id');
    });

    it('leaves CLDR script matching intact — Intl canonicalises its own input', () => {
        // This was the basis of the objection to lowercase, and it was wrong.
        expect(maximizedLangScript('zh-tw')).toBe(maximizedLangScript('zh-TW'));
        expect(maximizedLangScript('zh-tw')).not.toBe(maximizedLangScript('zh-cn'));
    });

    it('is idempotent, so a value can cross the boundary twice safely', () => {
        const once = canonicalizeLocale('ZH_hant_tw');
        expect(canonicalizeLocale(once)).toBe(once);
        const posix = canonicalizeLocale('iw_IL_POSIX');
        expect(canonicalizeLocale(posix)).toBe(posix);
    });
});

describe('WIRE-3: every locale code the API holds is its own internal form', () => {
    // The API's Locale table, vendored from its seeder at the commit the fixture cites. A code
    // the core canonicalises into another names a locale the API does not hold, so a store
    // holding that code would be served no catalog and no reference lists.
    const { codes } = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/api-locale-codes.json'), 'utf8')) as {
        codes: string[];
    };

    it('has the table to check', () => {
        expect(codes.length).toBeGreaterThan(800);
        expect(codes).toContain('en-us-posix');
    });

    it('canonicalises every code to itself', () => {
        expect(codes.filter((code) => canonicalizeLocale(code) !== code)).toEqual([]);
    });
});
