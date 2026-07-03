import { describe, expect, it } from 'vitest';
import { canonicalizeLocale, maximizedLangScript } from '../src/locale.js';
import { LangsysApp } from '../src/langsys-app.js';

describe('canonicalizeLocale', () => {
    it('canonicalizes casing to BCP 47 form', () => {
        expect(canonicalizeLocale('en-us')).toBe('en-US');
        expect(canonicalizeLocale('EN-US')).toBe('en-US');
        expect(canonicalizeLocale('zh-hant-tw')).toBe('zh-Hant-TW');
        expect(canonicalizeLocale('sr-cyrl-rs')).toBe('sr-Cyrl-RS');
    });

    it('accepts underscore separators', () => {
        expect(canonicalizeLocale('en_US')).toBe('en-US');
        expect(canonicalizeLocale('zh_hant_tw')).toBe('zh-Hant-TW');
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
        expect(canonicalizeLocale(' en-us ')).toBe('en-US');
    });

    it('passes through empty/invalid input without throwing', () => {
        expect(canonicalizeLocale('')).toBe('');
        expect(() => canonicalizeLocale('!!not-a-tag!!')).not.toThrow();
    });
});

describe('maximizedLangScript', () => {
    it('infers script via CLDR likely subtags', () => {
        expect(maximizedLangScript('zh')).toBe('zh-Hans');
        expect(maximizedLangScript('zh-CN')).toBe('zh-Hans');
        expect(maximizedLangScript('zh-TW')).toBe('zh-Hant');
        expect(maximizedLangScript('zh-Hant-TW')).toBe('zh-Hant');
        expect(maximizedLangScript('sr')).toBe('sr-Cyrl');
        expect(maximizedLangScript('es-MX')).toBe('es-Latn');
    });

    it('returns null for unparseable tags', () => {
        expect(maximizedLangScript('!!')).toBeNull();
    });
});

describe('LangsysApp.detectPreferredLocale — CLDR matching', () => {
    it('returns exact canonical matches', () => {
        expect(LangsysApp.detectPreferredLocale('en-us', ['en-US', 'fr-FR'])).toBe('en-US');
    });

    it('canonicalizes supported-locale casing too', () => {
        expect(LangsysApp.detectPreferredLocale('en-US', ['en-us'])).toBe('en-US');
    });

    it('matches language+script with region ignored (es-MX → es-ES)', () => {
        expect(LangsysApp.detectPreferredLocale('es-MX', ['es-ES', 'en-US'])).toBe('es-ES');
    });

    it('falls back from regional to bare language (es-ES → es)', () => {
        expect(LangsysApp.detectPreferredLocale('es-ES', ['es', 'en'])).toBe('es');
    });

    it('matches zh-Hans-CN to a bare zh catalog (zh likely-script is Hans)', () => {
        expect(LangsysApp.detectPreferredLocale('zh-Hans-CN', ['zh', 'en'])).toBe('zh');
    });

    it('matches zh-TW to zh-Hant, not zh-Hans', () => {
        expect(LangsysApp.detectPreferredLocale('zh-TW', ['zh-Hans', 'zh-Hant'])).toBe('zh-Hant');
    });

    it('never serves a Simplified catalog to a Traditional reader', () => {
        // No script-compatible candidate → falls through to the user's own
        // (canonicalized) first preference rather than mismatching scripts.
        expect(LangsysApp.detectPreferredLocale('zh-Hant-TW', ['zh-Hans', 'zh'])).toBe('zh-Hant-TW');
    });

    it('respects Accept-Language q-value ordering', () => {
        expect(LangsysApp.detectPreferredLocale('fr;q=0.8, en-US;q=0.9', ['fr-FR', 'en-US'])).toBe('en-US');
    });

    it('returns the canonical first preference when nothing is supported', () => {
        expect(LangsysApp.detectPreferredLocale('pt-br', ['ja-JP'])).toBe('pt-BR');
    });
});
