import { IntlMessageFormat } from 'intl-messageformat';
import { normalizeMarkupPlaceholders } from './identity.js';
import { logger } from './logger.js';

/**
 * Re-exported, not defined here: the CAPTURE-time rewrite is an identity rule
 * and lives in `identity.ts` with the other one. Kept on this module's surface
 * because eight call sites and both entry points import it from here.
 */
export { normalizeMarkupPlaceholders };

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
 * Accept `%name%` at RENDER time, not only at capture time.
 *
 * `normalizeMarkupPlaceholders` has always converted `%name%` to `{name}` where
 * content is captured, because Svelte and JSX consume a bare `{name}` in markup
 * and `%name%` is what an author can actually type there. But nothing applied it
 * on the way out, so a translation stored with `%name%` rendered the percent
 * signs to the reader verbatim: `interpolate('Hi %name%', { name: 'Ada' })`
 * returned `'Hi %name%'`.
 *
 * Conversion is CONDITIONAL on the key being supplied, which matters: a blanket
 * rewrite would treat any `%word%` as a placeholder, so `'Save 20% %off%'` or
 * prose containing `%s` patterns could be mangled into a `{…}` that then renders
 * as a literal brace expression. Requiring a matching param means a string is
 * only reinterpreted when the caller demonstrably meant it as a placeholder.
 */
function adoptPercentPlaceholders(template: string, params: Record<string, unknown>): string {
    if (!template.includes('%') || !params) return template;
    return template.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? `{${name}}` : whole
    );
}


/** Keys `%name%` can carry — the same shape `adoptPercentPlaceholders` matches. */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a params key for literal use inside a RegExp. */
function escapeForRegExp(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Params keys that have NO matching placeholder in `texts`.
 *
 * A key counts as used when it appears as `{key}`, as the argument of an ICU
 * slot (`{key, plural, …}`), or as `%key%`. Surrounding whitespace is tolerated
 * in the brace forms.
 *
 * BOTH SPELLINGS, because `interpolate` resolves both. It used to accept the
 * brace forms only, on the stated assumption that texts arrive canonical
 * (post-`normalizeMarkupPlaceholders`). That held for the two internal callers
 * and still does — `<Translate>` normalizes its tokens at capture and
 * `<Phrase>`'s string comes out of `encodeRichText` already rewritten — but it
 * stopped being true of the function itself once `interpolate` began adopting
 * `%name%` at render time. A caller passing a raw stored translation then got
 * `name` reported unused for a param that renders perfectly, and
 * `warnUnmatchedParams` told them to "write %name% instead" — which is what they
 * had written. This predicate and `adoptPercentPlaceholders` have to agree about
 * what a placeholder is; they are two halves of one rule.
 *
 * The percent spelling is accepted only for keys that are IDENTIFIERS, matching
 * `adoptPercentPlaceholders` exactly. A key like `a.b` never resolves from
 * `%a.b%` — accepting it here would suppress a warning that is correct.
 */
export function findUnusedParamKeys(texts: string[], params: Record<string, unknown> | undefined): string[] {
    if (!params) return [];
    const keys = Object.keys(params);
    if (!keys.length || !texts.length) return keys;

    // The separator is a literal NUL, written as an ESCAPE and never as the byte
    // itself. A raw 0x00 in a source file makes git classify it as binary: no
    // diff, no blame, no 3-way merge, and every change to this file becomes
    // invisible to review while still shipping. It hid here once already.
    const haystack = texts.join('\0');
    return keys.filter((key) => {
        const escaped = escapeForRegExp(key);
        const percent = IDENTIFIER_KEY.test(key) ? `|%${escaped}%` : '';
        return !new RegExp(`\\{\\s*${escaped}\\s*[,}]${percent}`).test(haystack);
    });
}

/**
 * Debug-time warning for the single most common markup-interpolation mistake:
 * writing `{name}` instead of `%name%` inside `<Translate>`/`<Phrase>` content.
 *
 * We can't see the mistake directly — Svelte and JSX substitute `{name}` at
 * compile time, so the SDK only ever receives the already-substituted text.
 * But the fingerprint is unmistakable: params were supplied and NONE of their
 * keys survive as placeholders in the captured content. Left undetected this
 * fails silently (the base locale still looks right), so it's worth naming
 * explicitly.
 *
 * Only emits when debug logging is on — silent in production.
 */
export function warnUnmatchedParams(
    source: string,
    texts: string[],
    params: Record<string, unknown> | undefined,
    context?: string,
): void {
    if (!logger.debugEnabled) return;

    const unused = findUnusedParamKeys(texts, params);
    if (!unused.length) return;

    const keyList = unused.map((key) => `%${key}%`).join(', ');
    // Framework-neutral wording: the brace spelling that gets eaten differs by
    // framework (Svelte/JSX consume `{key}`, Vue consumes `{{ key }}`), and the
    // SDK has no idea which one it's running under.
    logger.warn(
        `${source} received params with no matching placeholder in its content: ${keyList}.` +
            ` If you wrote {${unused[0]}} or {{ ${unused[0]} }} in markup, your framework's template` +
            ` compiler substituted it before Langsys saw the text — write %${unused[0]}% instead.` +
            (context ? ` [${context}]` : ''),
    );
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
 *
 * `params` may be omitted, and behaves as an empty map: a select or plural renders
 * its `other` branch (ICU-1). Omitting it used to throw a TypeError inside recovery.
 */
export function interpolate(
    template: string,
    params: Record<string, unknown> = {},
    locale?: string,
): string {
    template = adoptPercentPlaceholders(template, params);

    if (isICU(template)) {
        const resolved = locale || 'en';
        // A null value does NOT throw — `intl-messageformat` coerces it (null
        // becomes 0, so `{count, plural…}` renders "0 items"). That would make a
        // bug indistinguishable from valid data: a real empty cart and a failure
        // to pass the count would render identically. So null is routed straight
        // to recovery, where it is treated as missing — matching langsys-php,
        // which tests this explicitly. A genuine 0 is untouched and still
        // renders "0 items".
        const hasNullParam = !!params && Object.values(params).some((value) => value === null);
        let formatterError: unknown;
        if (!hasNullParam) {
            try {
                return new IntlMessageFormat(template, resolved).format(params) as string;
            } catch (error) {
                formatterError = error;
            }
        }
        // `.ast` is typed private but is the parsed message the library formats
        // from, and `IntlMessageFormat` accepts an AST in place of a string.
        // Reaching for it avoids taking a second runtime dependency on the
        // parser just to re-parse what's already parsed. A phrase that does not
        // parse has no branches to select, so it takes the simple path.
        let ast: unknown;
        try {
            ast = (new IntlMessageFormat(template, resolved) as unknown as { ast?: unknown }).ast;
        } catch {
            return simpleInterpolate(template, params, locale);
        }
        if (!Array.isArray(ast)) return simpleInterpolate(template, params, locale);

        // A missing argument throws. Recover the sentence rather than dumping
        // ICU source to the page — see `_recoverMissingArgs`.
        const defaulted: string[] = [];
        const recovered = _recoverMissingArgs(JSON.parse(JSON.stringify(ast)) as IcuNode[], params, defaulted);
        if (defaulted.length) noteDefaultedArgs(template, resolved, defaulted);
        if (defaulted.length || formatterError === undefined) {
            try {
                return new IntlMessageFormat(recovered as never, resolved).format(params) as string;
            } catch (error) {
                formatterError = error;
            }
        }

        // Nothing was missing, or the recovered message still would not format:
        // the formatter itself failed on this phrase (ICU-6). Render it without
        // the formatter, and say so at every log level.
        noteFormatterFailure(template, resolved, formatterError);
        return renderWithoutFormatter(ast as IcuNode[], params, resolved);
    }
    return simpleInterpolate(template, params, locale);
}

/** ICU AST node types we care about (from `@formatjs/icu-messageformat-parser`). */
const ICU_LITERAL = 0;
const ICU_ARGUMENT = 1;
const ICU_NUMBER = 2;
const ICU_DATE = 3;
const ICU_TIME = 4;
const ICU_SELECT = 5;
const ICU_PLURAL = 6;
const ICU_POUND = 7;
const ICU_TAG = 8;

interface IcuNode {
    type: number;
    value?: string;
    options?: Record<string, { value: IcuNode[] }>;
    children?: IcuNode[];
    offset?: number;
    pluralType?: 'cardinal' | 'ordinal';
}

/**
 * Rewrite an ICU AST so a MISSING argument degrades gracefully instead of
 * taking the whole message down.
 *
 * Why this is reachable without any caller mistake: langsys-ai's ICU promoter
 * can *introduce* a select argument the source phrase never had — a plain
 * `{name}` becomes `{name_gender, select, …}` in gendered target locales. The
 * application cannot supply `name_gender`; it doesn't exist in the phrase the
 * developer wrote, and nothing tells them the target grew one. Every app
 * translating into a gendered locale hits this.
 *
 * The recovery, agreed with `langsys-php` so a shared catalog can't render two
 * different sentences for the same input:
 *
 *  - **`select`** → take the `other` branch. Recoverable: `other` is exactly
 *    what an unknown gender should render, so the sentence comes out correct.
 *  - **`plural`** → take the `other` branch, rendering `#` as `{argName}`.
 *    Nothing can be inferred for a count, so this is only made less bad: the
 *    sentence survives with a visible gap.
 *  - **plain arguments** (`{name}`, `{n, number}`, dates) → render as
 *    `{argName}`, matching the simple path's rule that unknown keys stay
 *    visible rather than blanking.
 *
 * Elements whose argument IS supplied are left untouched and recursed into, so
 * a missing argument nested inside a satisfied branch is still recovered.
 * `plural`/`select` without an `other` branch is malformed ICU — left alone, so
 * it falls through to the simple path as before.
 */
/**
 * Templates already reported on, keyed by template+locale.
 *
 * Recovery is silent by design in production — that is the whole point — but
 * silence is also what makes the argument undiscoverable: it does not appear in
 * the source phrase, so a developer has no way to learn that `{name}` became
 * `{name_gender, select, …}` in Spanish and that their app could be supplying
 * it. Debug mode is the one place they can be told. Deduped because this runs
 * on every render of every string.
 */
const notifiedDefaults = new Set<string>();

function noteDefaultedArgs(template: string, locale: string, names: string[]): void {
    if (!logger.debugEnabled) return;

    const key = `${locale}\0${template}`;
    if (notifiedDefaults.has(key)) return;
    notifiedDefaults.add(key);

    const unique = [...new Set(names)];
    logger.warn(
        `Interpolation defaulted ${unique.length === 1 ? 'argument' : 'arguments'} ${unique
            .map((n) => `"${n}"`)
            .join(', ')} while rendering a '${locale}' string. The translated phrase asks for ` +
            `${unique.length === 1 ? 'it' : 'them'} but the source phrase does not, which is normal — a gendered ` +
            `target locale can introduce an argument the source never had. The neutral branch was used. Pass ` +
            `${unique.length === 1 ? 'the value' : 'the values'} in \`params\` if your app knows ${unique.length === 1 ? 'it' : 'them'}.`
    );
}

function _recoverMissingArgs(
    nodes: IcuNode[],
    params: Record<string, unknown>,
    defaulted: string[]
): IcuNode[] {
    const out: IcuNode[] = [];

    for (const node of nodes) {
        const name = node.value;
        // `null` counts as missing, matching the simple path where a present-
        // but-null value is left visible rather than rendered as 0 or "null".
        const value = name !== undefined && name in params ? params[name] : undefined;
        const supplied = value !== undefined && value !== null;

        if (node.type === ICU_TAG) {
            out.push({ ...node, children: _recoverMissingArgs(node.children ?? [], params, defaulted) });
            continue;
        }

        if (node.type === ICU_SELECT || node.type === ICU_PLURAL) {
            if (supplied) {
                const options: Record<string, { value: IcuNode[] }> = {};
                for (const [key, branch] of Object.entries(node.options ?? {})) {
                    options[key] = { value: _recoverMissingArgs(branch.value, params, defaulted) };
                }
                out.push({ ...node, options });
                continue;
            }
            const other = node.options?.other;
            if (!other) {
                out.push(node); // malformed — let the simple path handle it
                continue;
            }
            if (name) defaulted.push(name);
            const branch = _recoverMissingArgs(other.value, params, defaulted);
            // `#` has no count to render, so show the argument name instead.
            out.push(
                ...branch.map((child) =>
                    child.type === ICU_POUND ? { type: ICU_LITERAL, value: `{${name}}` } : child,
                ),
            );
            continue;
        }

        if (
            !supplied &&
            (node.type === ICU_ARGUMENT ||
                node.type === ICU_NUMBER ||
                node.type === ICU_DATE ||
                node.type === ICU_TIME)
        ) {
            if (name) defaulted.push(name);
            out.push({ type: ICU_LITERAL, value: `{${name}}` });
            continue;
        }

        out.push(node);
    }

    return out;
}

/** Templates whose formatter failure has been reported, keyed by template+locale. */
const notifiedFailures = new Set<string>();

/**
 * A formatter failure warns whether or not debug logging is on, unlike the
 * defaulted-argument notice above: a missing argument is normal, while a phrase
 * the formatter cannot render is a defect somebody has to fix. Deduped per
 * (template, locale) because this runs on every render.
 */
function noteFormatterFailure(template: string, locale: string, error: unknown): void {
    const key = `${locale}\0${template}`;
    if (notifiedFailures.has(key)) return;
    notifiedFailures.add(key);

    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
        `The message formatter failed on a '${locale}' phrase, so it was rendered by the SDK's own branch ` +
            `selection. Fix the phrase: ${JSON.stringify(template)}. Formatter error: ${reason}`
    );
}

/**
 * Render a parsed ICU message without the formatter (ICU-6), the way
 * `_recoverMissingArgs` treats a missing argument: each `select` or `plural`
 * takes the branch for its supplied value and the construct itself is dropped,
 * supplied values are filled in, and an unsupplied one stays visible as
 * `{argName}`. Never returns the raw construct.
 *
 * Plural branch order is ICU's: an exact `=N` on the value first, then the
 * value's CLDR category in the render locale (after the offset), then `other`.
 */
function renderWithoutFormatter(nodes: IcuNode[], params: Record<string, unknown>, locale: string, pound?: number | string): string {
    let out = '';
    for (const node of nodes) {
        const name = node.value;
        const value = name !== undefined && params && name in params ? params[name] : undefined;
        const supplied = value !== undefined && value !== null;

        switch (node.type) {
            case ICU_LITERAL:
                out += node.value ?? '';
                break;
            case ICU_POUND:
                out += pound === undefined ? '#' : typeof pound === 'string' ? pound : formatScalar(pound, locale);
                break;
            case ICU_TAG:
                out += `<${name}>${renderWithoutFormatter(node.children ?? [], params, locale, pound)}</${name}>`;
                break;
            case ICU_SELECT: {
                const options = node.options ?? {};
                const branch = (supplied ? options[String(value)] : undefined) ?? options.other;
                out += branch ? renderWithoutFormatter(branch.value, params, locale, pound) : `{${name}}`;
                break;
            }
            case ICU_PLURAL: {
                const options = node.options ?? {};
                const count = supplied ? Number(value) : NaN;
                if (Number.isNaN(count)) {
                    const other = options.other;
                    // `#` has no count to render, so show the argument name instead.
                    out += other ? renderWithoutFormatter(other.value, params, locale, `{${name}}`) : `{${name}}`;
                    break;
                }
                const adjusted = count - (node.offset ?? 0);
                let branch = options[`=${count}`];
                if (!branch) {
                    try {
                        branch = options[new Intl.PluralRules(locale, { type: node.pluralType ?? 'cardinal' }).select(adjusted)];
                    } catch {
                        // no CLDR rules for this locale: `other` below
                    }
                }
                branch = branch ?? options.other;
                out += branch ? renderWithoutFormatter(branch.value, params, locale, adjusted) : `{${name}}`;
                break;
            }
            default:
                // Plain, number, date and time arguments.
                out += supplied ? formatScalar(value, locale) : `{${name}}`;
        }
    }
    return out;
}

/** A supplied value as the simple path renders it: CLDR numbers and medium dates. */
function formatScalar(value: unknown, locale: string): string {
    try {
        if (value instanceof Date) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value);
        if (typeof value === 'number' || typeof value === 'bigint') return new Intl.NumberFormat(locale).format(value);
    } catch {
        // an invalid locale tag: the locale-blind rendering below
    }
    return value instanceof Date ? value.toISOString() : String(value);
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
