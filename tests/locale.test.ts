import { describe, expect, it } from 'vitest';
import { canonicalizeLocale, maximizedLangScript } from '../src/locale.js';
import { LangsysApp } from '../src/langsys-app.js';

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
        // No script-compatible candidate → falls through to the user's own
        // (canonicalized) first preference rather than mismatching scripts.
        expect(LangsysApp.detectPreferredLocale('zh-Hant-TW', ['zh-Hans', 'zh'])).toBe('zh-hant-tw');
    });

    it('respects Accept-Language q-value ordering', () => {
        expect(LangsysApp.detectPreferredLocale('fr;q=0.8, en-US;q=0.9', ['fr-FR', 'en-US'])).toBe('en-us');
    });

    it('returns the normalised first preference when nothing is supported', () => {
        expect(LangsysApp.detectPreferredLocale('pt-br', ['ja-JP'])).toBe('pt-br');
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
    });
});
