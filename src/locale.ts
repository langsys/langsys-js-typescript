import { logger } from './logger.js';
/**
 * Locale-identifier handling, CLDR/BCP 47 flavored. Everything here rides on
 * the platform's native `Intl` — no bundled locale data.
 *
 * The SDK's convention: canonicalize once at every input boundary (init
 * config, user-locale store emissions, detectPreferredLocale, API routes) and
 * treat the canonical string as the identity everywhere downstream — cache
 * keys, equality checks, and the wire format all use it.
 */

/**
 * Canonicalize a locale identifier to BCP 47 canonical form (the form CLDR
 * data is keyed by): language lowercase, script Titlecase, region uppercase —
 * `en-us` → `en-US`, `zh-hant-tw` → `zh-Hant-TW`. Underscores are accepted
 * and converted (`en_US` → `en-US`). Legacy aliases are resolved (`iw` → `he`,
 * `in` → `id`).
 *
 * Structurally invalid tags fall back to best-effort manual casing rather
 * than throwing, so a bad config value degrades to a failed catalog lookup
 * instead of a crash.
 */
export function canonicalizeLocale(locale: string): string {
    if (!locale || typeof locale !== 'string') return locale;
    const cleaned = locale.trim().replace(/_/g, '-');
    try {
        const [canonical] = Intl.getCanonicalLocales(cleaned);
        return canonical ?? cleaned;
    } catch {
        // Not a valid BCP 47 tag. The return value cannot signal this — a
        // best-effort cased string is indistinguishable from a successfully
        // canonicalized one, so a typo'd config locale degrades to a silent
        // failed catalog lookup: the app renders base language, which is
        // exactly what a legitimately-untranslated locale looks like. Say so
        // when debug is on, since nothing downstream can.
        if (logger.debugEnabled) logger.warn(
            `"${locale}" is not a valid BCP 47 locale tag. Falling back to best-effort casing,` +
                ` which will very likely miss the catalog and render base language with no other symptom.`,
        );
        // Apply canonical casing per subtag shape.
        return cleaned
            .split('-')
            .map((part, i) => {
                if (i === 0) return part.toLowerCase();
                if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase();
                if (part.length === 2 || /^\d{3}$/.test(part)) return part.toUpperCase();
                return part.toLowerCase();
            })
            .join('-');
    }
}

/**
 * The `language-script` key of a locale after CLDR likely-subtags expansion
 * (`Intl.Locale.maximize()`): `zh` → `zh-Hans`, `zh-TW` → `zh-Hant`,
 * `sr` → `sr-Cyrl`. Two locales with the same key are mutually intelligible
 * at the script level; two with different keys must not fall back to each
 * other (a `zh-Hant` reader must never receive a `zh-Hans` catalog).
 *
 * Returns `null` when the tag can't be parsed — callers should treat that
 * as "no match" rather than guessing.
 */
export function maximizedLangScript(locale: string): string | null {
    try {
        const max = new Intl.Locale(canonicalizeLocale(locale)).maximize();
        return `${max.language}-${max.script ?? ''}`;
    } catch {
        return null;
    }
}
