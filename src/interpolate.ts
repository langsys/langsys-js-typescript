import { IntlMessageFormat } from 'intl-messageformat';

/**
 * Detects ICU MessageFormat syntax in a translation string.
 *
 *   - Matches `{var, plural, …}`, `{var, select, …}`, `{var, selectordinal, …}`,
 *     `{var, number, …}`, `{var, date, …}`, `{var, time, …}`.
 *   - Also matches the style-less forms `{var, number}`, `{var, date}`,
 *     `{var, time}` — valid ICU with the locale-default style.
 *   - Doesn't match plain interpolation slots like `{name}` or `{count}`.
 *
 * Exported because the Translation Manager UI needs the same detection logic
 * to decide whether to render a plural-slot editor vs. a single text field.
 */
export function isICU(template: string): boolean {
    return ICU_PATTERN.test(template);
}

// `[,}]` after the keyword: a style argument may follow (`{n, number, ::…}`)
// or the argument may close immediately (`{n, number}` — locale-default style).
const ICU_PATTERN = /\{[^{}]+,\s*(plural|select|selectordinal|number|date|time)\s*[,}]/;

/**
 * Normalize `%name%` markup placeholders to canonical `{name}`.
 *
 * Framework compilers consume bare `{name}` written in markup before the DOM
 * walker ever sees it (Svelte compiles it to an expression; JSX evaluates it),
 * so DOM content accepts `%name%` as a collision-free authoring escape.
 * Normalization runs at every markup capture boundary (content-block
 * tokenizer, `Translate` original-value snapshots, `Phrase` encoding), so the
 * catalog, the wire, and translators only ever see the canonical `{name}`
 * form — and plain `{name}` keeps working for vanilla-HTML authors.
 *
 * Keys must be identifiers (`[A-Za-z_][A-Za-z0-9_]*`), so literal `%` in
 * prose ("20% off", "50% to 60%") can't match. `t()` phrases are JS strings
 * with no compiler collision and stay `{name}`-only.
 */
export function normalizeMarkupPlaceholders(text: string): string {
    return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, '{$1}');
}

/**
 * Substitute placeholders in a translated string with values from `params`.
 *
 * Two paths:
 *   - ICU MessageFormat (target string contains `{var, plural|select|…, …}`):
 *     parsed and formatted via `intl-messageformat`, which knows every
 *     target locale's plural rules (Arabic's 6 categories, Russian's 4,
 *     etc.) and gender-select branches.
 *   - Simple `{name}` interpolation: cheap regex replacement. Unknown
 *     placeholders are left untouched so missing data is visible to the
 *     developer rather than silently rendering empty strings. Number and
 *     Date values are formatted per the target locale's CLDR rules
 *     (`Intl.NumberFormat` / `Intl.DateTimeFormat`) — pass numbers as
 *     strings to opt out (e.g. IDs and codes that must not get grouping
 *     separators).
 *
 * Malformed ICU falls through to simple interpolation rather than throwing,
 * so the developer sees a broken-but-visible string instead of a runtime crash.
 * Backend-side validation in langsys-ai is supposed to prevent this — the
 * fall-through is defense in depth.
 *
 * `locale` is required for ICU formatting (drives plural-rule selection).
 * Falls back to `'en'` if absent — simple-interpolation path ignores it.
 */
export function interpolate(
    template: string,
    params: Record<string, unknown>,
    locale?: string,
): string {
    if (isICU(template)) {
        try {
            return new IntlMessageFormat(template, locale || 'en').format(params) as string;
        } catch {
            return simpleInterpolate(template, params, locale);
        }
    }
    return simpleInterpolate(template, params, locale);
}

function simpleInterpolate(template: string, params: Record<string, unknown>, locale?: string): string {
    // The `[^{},]` character class excludes `{`, `}`, and `,` from placeholder
    // names so we don't accidentally consume ICU-shaped slots that somehow
    // routed through this path (e.g. malformed ICU after fall-through).
    return template.replace(/\{([^{},]+)\}/g, (match, rawKey: string) => {
        const key = rawKey.trim();
        if (!(key in params)) return match;
        const value = params[key];
        if (value === undefined || value === null) return match;
        // CLDR-formatted output for numbers and dates, mirroring what the ICU
        // defaults (`{n, number}`, `{d, date}` → medium) would produce. The
        // try/catch guards against invalid locale tags — fall back to the
        // locale-blind rendering rather than throwing mid-render.
        if (value instanceof Date) {
            try {
                return new Intl.DateTimeFormat(locale || 'en', { dateStyle: 'medium' }).format(value);
            } catch {
                return value.toISOString();
            }
        }
        if (typeof value === 'number' || typeof value === 'bigint') {
            try {
                return new Intl.NumberFormat(locale || 'en').format(value);
            } catch {
                return String(value);
            }
        }
        return String(value);
    });
}
