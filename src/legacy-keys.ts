import {
    convertLegacyPluralForms,
    convertLegacyValue,
    LEGACY_FORMATS,
    PLURAL_CATEGORIES,
    SUPPORTED_LEGACY_FORMATS,
    type LegacyConversion,
    type LegacyFormat,
} from './legacy-value.js';

/**
 * Legacy i18n keys resolved against an app's kept source-language files
 * (spec MIG-2, MIG-5, MIG-7).
 *
 * Pure and fs-free: each file is passed already parsed, as `{ name, format?,
 * namespace?, data }`, so the browser `t()` mode and a server `t()` read one
 * configuration through one resolver and register one phrase per key.
 *
 * - **Formats.** This core reads `i18next`, `vue-i18n` and `plain`, all JSON. A
 *   file with no declared format is `plain`. A file declaring any other format,
 *   or whose name marks it as another ecosystem's (`.php`, `.yml`, `.po`,
 *   `.mo`), is refused when the resolver is built, with an error naming the
 *   format and the file.
 * - **Lookup.** A key is read as written first, then by dotted path. The first
 *   configured file that holds it answers, and a key held by more than one file
 *   is reported by `duplicates()`.
 * - **Category.** A key shaped like a path (`checkout.submit`) contributes its
 *   first segment; a file with a `namespace` answers only keys under it
 *   (`checkout.submit` in a file with namespace `checkout`) and contributes the
 *   namespace. A sentence used as its own key has none.
 * - **Plurals.** In an `i18next` file, suffix-paired keys (`items_one`,
 *   `items_other`, or the older `items` / `items_plural`) resolve together as
 *   one plural under their base key.
 */

/** One configured source file. `data` is its parsed JSON object. */
export interface LegacyKeyFile {
    /** The file's path or name, as errors and reports should name it. */
    name: string;
    /** `i18next`, `vue-i18n` or `plain`. Defaults to `plain`. */
    format?: string;
    /** When set, the file answers only keys prefixed `namespace.`, and the namespace is their category. */
    namespace?: string;
    data: unknown;
}

/** A key the files hold, converted. */
export interface LegacyKeyHit extends LegacyConversion {
    /** The phrase to register: the converted value, or the value as written when not `recognised`. */
    phrase: string;
    /** The category the key contributes, or null for none (MIG-5). */
    category: string | null;
    key: string;
    /** The file that answered. */
    file: string;
}

/** What cannot be migrated as it stands, for a listing command (MIG-4, MIG-7). */
export interface LegacyKeyProblem {
    file: string;
    key: string | null;
    issue: string;
    fix: string;
}

export interface LegacyKeys {
    /** The key's converted source value, or null when no file holds it (the MIG-2 miss). */
    resolve(key: string): LegacyKeyHit | null;
    /** Keys held by more than one file, with those files in configured order; the first answers. */
    duplicates(): Record<string, string[]>;
    /** Every value that converts to nothing recognised, and every file that is not a JSON object. */
    problems(): LegacyKeyProblem[];
}

/** Thrown when the configuration names a file this core cannot read (MIG-7). */
export class LegacyFormatError extends Error {
    constructor(
        message: string,
        readonly file: string,
        readonly format: string
    ) {
        super(message);
        this.name = 'LegacyFormatError';
    }
}

interface NormalizedFile {
    name: string;
    format: LegacyFormat;
    namespace: string | null;
    data: Record<string, unknown> | null;
}

type PluralForms = Partial<Record<(typeof PLURAL_CATEGORIES)[number], string>>;

/** The format another ecosystem's file type implies, so it is refused by name rather than read as JSON. */
const FOREIGN_EXTENSIONS: Record<string, string> = {
    php: 'laravel',
    yml: 'rails-i18n',
    yaml: 'rails-i18n',
    po: 'gettext',
    mo: 'gettext',
};

/**
 * Build a resolver over configured files. Throws `LegacyFormatError` for a file
 * this core does not read — never silently, since a skipped file would turn
 * every one of its keys into a literal phrase named after the key.
 */
export function createLegacyKeys(files: LegacyKeyFile[]): LegacyKeys {
    const normalized = files.map(normalize);

    return {
        resolve(key) {
            if (typeof key !== 'string' || key === '') return null;
            for (const file of normalized) {
                const found = lookup(file, key);
                if (!found) continue;
                const converted = convert(found.value, file.format);
                return { ...converted, phrase: converted.text, category: found.category, key, file: file.name };
            }
            return null;
        },

        duplicates() {
            const seen: Record<string, string[]> = {};
            for (const file of normalized) {
                for (const key of Object.keys(leaves(file))) (seen[key] ??= []).push(file.name);
            }
            return Object.fromEntries(Object.entries(seen).filter(([, names]) => names.length > 1));
        },

        problems() {
            const problems: LegacyKeyProblem[] = [];
            for (const file of normalized) {
                if (file.data === null) {
                    problems.push({ file: file.name, key: null, issue: 'is not a JSON object', fix: 'pass the parsed contents of the file' });
                    continue;
                }
                for (const [key, value] of Object.entries(leaves(file))) {
                    const converted = convert(value, file.format);
                    if (!converted.recognised) {
                        problems.push({
                            file: file.name,
                            key,
                            issue: converted.issue!,
                            fix: "rewrite the value as Langsys source text, or declare the file's format",
                        });
                    }
                }
            }
            return problems;
        },
    };
}

function normalize(file: LegacyKeyFile): NormalizedFile {
    const name = String(file?.name ?? '');
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';

    if (extension === 'mo') {
        const po = name.slice(0, -3) + '.po';
        throw new LegacyFormatError(
            `The legacy file ${name} is a compiled gettext catalog. gettext reads .po only (${po}), and gettext is not a format this core reads; it reads ${SUPPORTED_LEGACY_FORMATS.join(', ')}.`,
            name,
            'gettext'
        );
    }

    const declared = file?.format;
    const format = declared ?? FOREIGN_EXTENSIONS[extension] ?? 'plain';
    if (!(SUPPORTED_LEGACY_FORMATS as readonly string[]).includes(format)) {
        const known = (LEGACY_FORMATS as readonly string[]).includes(format);
        throw new LegacyFormatError(
            `The legacy file ${name} is in the ${known ? '' : 'unknown '}format "${format}", which this core does not read. It reads ${SUPPORTED_LEGACY_FORMATS.join(', ')}.`,
            name,
            format
        );
    }

    const data = isRecord(file?.data) ? file.data : null;
    return { name, format: format as LegacyFormat, namespace: file?.namespace ? String(file.namespace) : null, data };
}

function lookup(file: NormalizedFile, key: string): { value: string | PluralForms; category: string | null } | null {
    if (!file.data) return null;
    const pairs = file.format === 'i18next';

    if (file.namespace !== null) {
        if (!key.startsWith(file.namespace + '.')) return null;
        const value = valueAt(file.data, key.slice(file.namespace.length + 1).split('.'), pairs);
        return value === null ? null : { value, category: file.namespace };
    }

    if (!key.includes('.')) {
        // Read through the pairing, so an i18next plural base (`items` for
        // `items_one`, `item` for `item_plural`) resolves as its plural.
        const value = valueAt(file.data, [key], pairs);
        return value === null ? null : { value, category: null };
    }

    const flat = file.data[key];
    if (typeof flat === 'string') return { value: flat, category: looksLikeAPath(key) ? key.slice(0, key.indexOf('.')) : null };

    const value = valueAt(file.data, key.split('.'), pairs);
    return value === null ? null : { value, category: key.slice(0, key.indexOf('.')) };
}

/** A string at a path, or — in an i18next file — plural forms when the key is suffix-paired. */
function valueAt(data: Record<string, unknown>, segments: string[], pairs: boolean): string | PluralForms | null {
    const last = segments.pop()!;
    let container: unknown = data;
    for (const segment of segments) {
        if (!isRecord(container) || !(segment in container)) return null;
        container = container[segment];
    }
    if (!isRecord(container)) return null;

    if (pairs) {
        const forms: PluralForms = {};
        for (const category of PLURAL_CATEGORIES) {
            const value = container[`${last}_${category}`];
            if (typeof value === 'string') forms[category] = value;
        }
        if (Object.keys(forms).length > 0) return forms;
        const singular = container[last];
        const pluralForm = container[`${last}_plural`];
        if (typeof singular === 'string' && typeof pluralForm === 'string') return { one: singular, other: pluralForm };
    }

    const value = container[last];
    return typeof value === 'string' ? value : null;
}

/** Every leaf by its full key: strings, and — in an i18next file — plural forms under their base key. */
function leaves(file: NormalizedFile): Record<string, string | PluralForms> {
    const out: Record<string, string | PluralForms> = {};
    if (!file.data) return out;
    const prefix = file.namespace !== null ? file.namespace + '.' : '';
    collect(file.data, prefix, out, file.format === 'i18next');
    return out;
}

const SUFFIXES = [...PLURAL_CATEGORIES.map((c) => `_${c}`), '_plural'];

function collect(node: Record<string, unknown>, prefix: string, out: Record<string, string | PluralForms>, pairs: boolean): void {
    for (const [key, value] of Object.entries(node)) {
        if (isRecord(value)) {
            collect(value, `${prefix}${key}.`, out, pairs);
            continue;
        }
        if (typeof value !== 'string') continue;

        if (pairs) {
            const suffix = SUFFIXES.find((s) => key.endsWith(s) && key.length > s.length);
            if (suffix) {
                const base = key.slice(0, -suffix.length);
                const forms = valueAt(node, [base], true);
                if (forms !== null && typeof forms !== 'string') {
                    out[prefix + base] = forms;
                    continue;
                }
            }
        }
        if (!(prefix + key in out)) out[prefix + key] = value;
    }
}

function convert(value: string | PluralForms, format: LegacyFormat): LegacyConversion {
    return typeof value === 'string' ? convertLegacyValue(value, format) : convertLegacyPluralForms(value);
}

/** A flat key names a category only when it is shaped like a key path; a sentence used as its own key has none. */
function looksLikeAPath(key: string): boolean {
    return /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
