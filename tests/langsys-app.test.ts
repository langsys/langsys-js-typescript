import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';

/**
 * `locales` is private and populated by `getLocalesData`. Seeding it directly
 * keeps these tests on the function under test instead of on the HTTP client.
 */
function seedLocaleCache(locale: string, entries: { code: string; locale_name: string; lang_name: string }[]) {
    (LangsysApp as unknown as { locales: Record<string, unknown[]> }).locales[locale] = entries;
}

function clearLocaleCache() {
    (LangsysApp as unknown as { locales: Record<string, unknown[]> }).locales = {};
}

describe('detectPreferredLocale returns false when nothing is supported', () => {
    // The documented idiom is `detectPreferredLocale(header, supported) || 'en-US'`.
    // That only works if an unsupported preference yields false: returning the
    // user's own locale instead lands the app on a catalog it does not have,
    // and the caller's `||` default never fires.
    it('is false when no user preference matches the supported list', () => {
        expect(LangsysApp.detectPreferredLocale('de-DE,de;q=0.9', ['en-us', 'fr-fr'])).toBe(false);
    });

    it('still matches exactly when it can', () => {
        expect(LangsysApp.detectPreferredLocale('fr-FR,fr;q=0.9', ['en-us', 'fr-fr'])).toBe('fr-fr');
    });

    it('still matches by language+script through CLDR expansion', () => {
        expect(LangsysApp.detectPreferredLocale('fr-CA,fr;q=0.9', ['en-us', 'fr-fr'])).toBe('fr-fr');
    });

    it('returns the first preference when no supported list is given', () => {
        expect(LangsysApp.detectPreferredLocale('de-DE,de;q=0.9')).toBe('de-de');
    });

    it('falls back to the platform preference when no header is given', () => {
        // Node 22 exposes navigator.languages === ['en-US'], so this is a
        // control rather than a no-preference case — pinned explicitly, since
        // the obvious reading of "no header" is "no preference", and it isn't.
        expect(LangsysApp.detectPreferredLocale('', ['en-us'])).toBe('en-us');
    });

    it('is false when no preference is detectable at all', () => {
        vi.stubGlobal('navigator', { languages: [], language: '' });
        try {
            expect(LangsysApp.detectPreferredLocale('', ['en-us'])).toBe(false);
            expect(LangsysApp.detectPreferredLocale('')).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('getLocaleName says which of the two failures happened', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        clearLocaleCache();
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        warn.mockRestore();
        clearLocaleCache();
    });

    it('warns that the data was never loaded, naming the call that loads it', () => {
        // The old warning said the LOOKUP failed, sending the developer to
        // check their locale code when the real problem was that they never
        // awaited `getLocalesData`. Same empty string, wrong diagnosis.
        expect(LangsysApp.getLocaleName('fr-fr', false, 'en-us')).toBe('');
        const said = warn.mock.calls.flat().join(' ');
        expect(said).toContain('getLocalesData');
        expect(said).not.toContain('failed to match');
    });

    it('warns about the entry, not the load, once data IS present', () => {
        seedLocaleCache('en-us', [{ code: 'fr-FR', locale_name: 'French (France)', lang_name: 'French' }]);
        expect(LangsysApp.getLocaleName('de-de', false, 'en-us')).toBe('');
        const said = warn.mock.calls.flat().join(' ');
        expect(said).toContain('no entry matching');
        expect(said).not.toContain('getLocalesData');
    });

    it('resolves a name once the data is loaded', () => {
        seedLocaleCache('en-us', [{ code: 'fr-FR', locale_name: 'French (France)', lang_name: 'French' }]);
        expect(LangsysApp.getLocaleName('fr-fr', false, 'en-us')).toBe('French (France)');
        expect(LangsysApp.getLocaleName('fr-fr', true, 'en-us')).toBe('French');
        expect(warn).not.toHaveBeenCalled();
    });
});
