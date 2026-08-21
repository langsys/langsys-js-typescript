import { logger } from './logger.js';
/**
 * Locale-identifier handling, CLDR/BCP 47 flavored. Everything here rides on
 * the platform's native `Intl` — no bundled locale data.
 *
 * The SDK's convention: normalise once at every input boundary (init config,
 * user-locale store emissions, detectPreferredLocale, API routes) and treat the
 * normalised string as the identity everywhere downstream — cache keys,
 * equality checks, and the wire format all use it.
 *
 * That form is LOWERCASE `xx-yy` (`en-us`, `zh-hant-tw`). It is what every
 * locale in the backend's database already is — script subtags included, stored
 * `az-cyrl` / `bs-latn` — and what the API's request middleware produces. It is
 * therefore the only form guaranteed to behave identically on a route that does
 * NOT mount that middleware, and the routes most likely to miss it are the
 * legacy ones carrying the oldest clients: exactly the clients least likely to
 * send a canonical form. Sending lowercase costs nothing; relying on a
 * normalisation we cannot see, cannot version, and will not be told about when
 * a route stops mounting it does.
 *
 * This does not weaken CLDR handling. `Intl` canonicalises its own input, so
 * `new Intl.Locale('zh-tw').maximize()` still yields `zh-Hant-TW` whether the
 * input was cased or not — likely-subtags matching is unaffected by the form we
 * hold. Validity is a separate axis from casing, which is why the invalid-tag
 * warning below is retained unchanged.
 */

/**
 * Normalise a locale identifier to the SDK's single internal form: lowercase
 * `xx-yy` — `en-US` → `en-us`, `zh-Hant-TW` → `zh-hant-tw`. Underscores are
 * accepted and converted (`en_US` → `en-us`). Legacy aliases are still resolved
 * through `Intl.getCanonicalLocales` (`iw` → `he`, `in` → `id`) BEFORE casing is
 * flattened — lowercasing first would lose them, since the alias table is keyed
 * on canonical tags.
 *
 * Structurally invalid tags fall back to lowercasing rather than throwing, so a
 * bad config value degrades to a failed catalog lookup instead of a crash — and
 * warns, because that failure is otherwise indistinguishable from a legitimately
 * untranslated locale.
 */
export function canonicalizeLocale(locale: string): string {
    if (!locale || typeof locale !== 'string') return locale;
    const cleaned = locale.trim().replace(/_/g, '-');
    try {
        const [canonical] = Intl.getCanonicalLocales(cleaned);
        return (canonical ?? cleaned).toLowerCase();
    } catch {
        // Not a valid BCP 47 tag. The return value cannot signal this — a
        // best-effort cased string is indistinguishable from a successfully
        // canonicalized one, so a typo'd config locale degrades to a silent
        // failed catalog lookup: the app renders base language, which is
        // exactly what a legitimately-untranslated locale looks like. Say so
        // when debug is on, since nothing downstream can.
        if (logger.debugEnabled) logger.warn(
            `"${locale}" is not a valid BCP 47 locale tag. Falling back to lowercasing it as-is,` +
                ` which will very likely miss the catalog and render base language with no other symptom.`,
        );
        // Lowercase anyway so the identity stays consistent — an invalid tag
        // must still compare equal to itself across boundaries.
        return cleaned.toLowerCase();
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
        // Intl canonicalises its own input, so the lowercase form we hold
        // maximises identically to a cased one. Lowercased for the same reason
        // everything else is: one internal form, compared only against itself.
        return `${max.language}-${max.script ?? ''}`.toLowerCase();
    } catch {
        return null;
    }
}
