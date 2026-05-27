import { IntlMessageFormat } from 'intl-messageformat';

/**
 * Detects ICU MessageFormat syntax in a translation string.
 *
 *   - Matches `{var, plural, …}`, `{var, select, …}`, `{var, selectordinal, …}`,
 *     `{var, number, …}`, `{var, date, …}`, `{var, time, …}`.
 *   - Doesn't match plain interpolation slots like `{name}` or `{count}`.
 *
 * Exported because the Translation Manager UI needs the same detection logic
 * to decide whether to render a plural-slot editor vs. a single text field.
 */
export function isICU(template: string): boolean {
    return ICU_PATTERN.test(template);
}

const ICU_PATTERN = /\{[^{}]+,\s*(plural|select|selectordinal|number|date|time)\s*,/;

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
 *     developer rather than silently rendering empty strings.
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
            return new IntlMessageFormat(template, locale ?? 'en').format(params) as string;
        } catch {
            return simpleInterpolate(template, params);
        }
    }
    return simpleInterpolate(template, params);
}

function simpleInterpolate(template: string, params: Record<string, unknown>): string {
    // The `[^{},]` character class excludes `{`, `}`, and `,` from placeholder
    // names so we don't accidentally consume ICU-shaped slots that somehow
    // routed through this path (e.g. malformed ICU after fall-through).
    return template.replace(/\{([^{},]+)\}/g, (match, rawKey: string) => {
        const key = rawKey.trim();
        if (!(key in params)) return match;
        const value = params[key];
        if (value === undefined || value === null) return match;
        if (value instanceof Date) return value.toISOString();
        return String(value);
    });
}
