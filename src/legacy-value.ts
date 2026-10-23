/**
 * Legacy i18n values to Langsys/ICU source text (spec MIG-4).
 *
 * A migrated app keeps its source-language file and its keys; a key's value
 * becomes the registered phrase after this conversion. The conversion decides
 * the phrase, so it is identity: every JS entry point — the browser `t()`
 * mode, a server `t()`, a vue-i18n or i18next bridge — converts through these
 * functions, never a copy of them.
 *
 * Placeholders convert the same way whatever the file's format. Plurals
 * convert by the format the file declares, because frameworks read the same
 * characters differently: vue-i18n reserves `|`, i18next pairs suffixed keys.
 * The conversion preserves the source framework's own selection. Anything a
 * format does not recognise comes back exactly as written, with `recognised`
 * false and the reason in `issue`, so it registers verbatim and is reported
 * rather than silently mangled.
 */

/** The formats a file can declare anywhere in the fleet (MIG-7). */
export const LEGACY_FORMATS = ['laravel', 'vue-i18n', 'i18next', 'gettext', 'rails-i18n', 'plain'] as const;

/** The formats this core reads (MIG-7). Any other configured format is refused at load. */
export const SUPPORTED_LEGACY_FORMATS = ['i18next', 'vue-i18n', 'plain'] as const;

export type LegacyFormat = (typeof SUPPORTED_LEGACY_FORMATS)[number];

/** A converted value. `text` is the phrase to register; when `recognised` is false it is the value as written. */
export interface LegacyConversion {
    text: string;
    recognised: boolean;
    issue: string | null;
}

/** CLDR plural categories, in ICU's customary order. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/**
 * Every placeholder spelling the fleet converts, scanned left to right in one
 * pass so a `%%` is consumed before its second `%` can start another match.
 * The spellings that carry formatting `{name}` cannot express, and positional
 * `%s`, are matched so they can be refused rather than half-converted.
 */
const PLACEHOLDER =
    /%%|%\{([A-Za-z_][A-Za-z0-9_]*)\}|%\(([A-Za-z_][A-Za-z0-9_]*)\)[sd]|%\([A-Za-z_][A-Za-z0-9_]*\)[-+ #0-9.]*[a-zA-Z]|%<[A-Za-z_][A-Za-z0-9_]*>[-+ #0-9.]*[a-zA-Z]|%(?:\.\d+)?[sdif](?![A-Za-z])|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}|(?<![\w:]):([a-z][a-z0-9_]*)/g;

/** Laravel's `:Name` / `:NAME` upper-case the value, which `{name}` cannot express. */
const CASE_TRANSFORM = /(?<![\w:]):[A-Z][A-Za-z0-9_]*/;

class Unconvertible extends Error {}

/**
 * Convert a value under a format.
 *
 * `plain` converts placeholders and nothing else; a `|` in it is text, so such
 * a value is returned verbatim and reported. `vue-i18n` reads any `|` as a
 * plural selected by count. `i18next` has no in-string plural — its plurals are
 * suffix-paired keys, see `convertLegacyPluralForms` — so a `|` is reported.
 */
export function convertLegacyValue(value: string, format: LegacyFormat = 'plain'): LegacyConversion {
    value = String(value);

    if (CASE_TRANSFORM.test(value)) {
        return unrecognised(value, 'uses a case-transforming placeholder (:Name or :NAME), which ICU cannot express');
    }

    if (!value.includes('|')) return convertPlaceholders(value);

    if (format === 'vue-i18n') return convertVuePipes(value);

    return unrecognised(
        value,
        format === 'i18next'
            ? 'holds a "|", which i18next does not read as a plural'
            : 'holds a "|" in a file with no plural format declared; declare the file\'s format to convert it'
    );
}

/**
 * One ICU plural from forms keyed by CLDR category — i18next's `key_one` /
 * `key_other` (and its older `key` / `key_plural` pair, as `one` / `other`).
 * i18next selects by locale, so the forms keep their CLDR categories.
 */
export function convertLegacyPluralForms(forms: Partial<Record<(typeof PLURAL_CATEGORIES)[number], string>>): LegacyConversion {
    const raw = PLURAL_CATEGORIES.filter((c) => forms[c] !== undefined)
        .map((c) => forms[c])
        .join(' | ');
    if (forms.other === undefined) return unrecognised(raw, 'is a plural with no "other" form');

    const branches: Array<[string, string]> = [];
    for (const category of PLURAL_CATEGORIES) {
        const text = forms[category];
        if (text === undefined) continue;
        if (CASE_TRANSFORM.test(text)) {
            return unrecognised(raw, 'uses a case-transforming placeholder (:Name or :NAME), which ICU cannot express');
        }
        branches.push([category, text]);
    }
    return plural(branches, raw);
}

/** A JS entry point that can receive legacy text (MIG-2). */
export type LegacyEntryPoint = 't' | 'vue-i18n' | 'i18next';

/**
 * Convert the text a call passed when it is not a key — a literal miss
 * (MIG-2) — by the entry point that received it, not by any file: the text is
 * written in the calling framework's syntax.
 *
 * Langsys `t()` converts nothing; its argument is already Langsys syntax. A
 * vue-i18n `$t` or i18next `t` bridge converts under its own format's row.
 */
export function convertLegacyCall(text: string, entryPoint: LegacyEntryPoint): LegacyConversion {
    if (entryPoint === 't') return { text: String(text), recognised: true, issue: null };
    if (entryPoint === 'vue-i18n' || entryPoint === 'i18next') return convertLegacyValue(text, entryPoint);
    throw new Error(`Unknown entry point "${String(entryPoint)}"; expected t, vue-i18n or i18next`);
}

/**
 * vue-i18n reserves `|` and selects by count, not by locale: with two forms, 1
 * picks the first and anything else the second; with three, 0, 1, then the
 * rest. Exact values keep that selection in every source language, where CLDR
 * `one` would not (in French it covers 0).
 */
function convertVuePipes(value: string): LegacyConversion {
    const segments = value.split('|').map((s) => s.trim());
    if (segments.length === 2) return plural([['=1', segments[0]!], ['other', segments[1]!]], value);
    if (segments.length === 3) return plural([['=0', segments[0]!], ['=1', segments[1]!], ['other', segments[2]!]], value);
    return unrecognised(value, `is a vue-i18n plural with ${segments.length} forms; only 2 or 3 map to ICU`);
}

/**
 * `{count, plural, <branches>}` with one space between parts, exact branches
 * first as given, then the CLDR categories in order — the string is the
 * phrase's identity, so it has exactly one spelling. The number inside a branch
 * is ICU's `#`, never `{count}`: some ICU builds accept `{count}` in a branch
 * of its own plural and then fail to format it.
 */
function plural(branches: Array<[string, string]>, raw: string): LegacyConversion {
    const parts: string[] = [];
    for (const [selector, text] of branches) {
        const converted = convertPlaceholders(text);
        if (!converted.recognised) return unrecognised(raw, converted.issue!);
        parts.push(`${selector} {${converted.text.replace(/\{(?:count|n)\}/g, '#')}}`);
    }
    return { text: `{count, plural, ${parts.join(' ')}}`, recognised: true, issue: null };
}

function convertPlaceholders(value: string): LegacyConversion {
    try {
        const text = value.replace(PLACEHOLDER, (match, rails?: string, python?: string, braces?: string, laravel?: string) => {
            if (match === '%%') return '%';
            const name = rails ?? python ?? braces ?? laravel;
            if (name !== undefined) return `{${name}}`;
            throw new Unconvertible(
                match.startsWith('%(') || match.startsWith('%<')
                    ? `uses a formatted placeholder (${match}), which {name} cannot express`
                    : `uses a positional placeholder (${match}), which names no argument`
            );
        });
        return { text, recognised: true, issue: null };
    } catch (error) {
        if (error instanceof Unconvertible) return unrecognised(value, error.message);
        throw error;
    }
}

function unrecognised(value: string, issue: string): LegacyConversion {
    return { text: value, recognised: false, issue };
}
