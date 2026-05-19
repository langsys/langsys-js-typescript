/**
 * Substitute `{name}`-style placeholders in a translated string with values
 * from `params`. Unknown placeholders are left untouched so missing data is
 * visible to the developer rather than silently rendering empty strings.
 *
 * Dates are serialized to ISO 8601; everything else goes through `String()`.
 * Designed as a forward-compatible stop-gap until ICU MessageFormat is wired
 * in for plurals/select/date formatting.
 */
export function interpolate(template: string, params: Record<string, unknown>): string {
    return template.replace(/\{([^{}]+)\}/g, (match, rawKey: string) => {
        const key = rawKey.trim();
        if (!(key in params)) return match;
        const value = params[key];
        if (value === undefined || value === null) return match;
        if (value instanceof Date) return value.toISOString();
        return String(value);
    });
}
