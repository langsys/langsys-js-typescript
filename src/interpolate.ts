import { IntlMessageFormat } from 'intl-messageformat';
import { logger } from './logger.js';

/**
 * The subset of an `intl-messageformat` AST node we walk. Declared locally
 * rather than imported: the parser package is only a transitive dependency,
 * and these three fields are all `withSelectDefaults` needs.
 */
type IcuNode = {
    value?: unknown;
    pluralType?: string;
    options?: Record<string, { value?: IcuNode[] }>;
};

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

/** Escape a params key for literal use inside a RegExp. */
function escapeForRegExp(key: string): string {
    return key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Params keys that have NO matching placeholder in `texts`.
 *
 * Texts are expected in canonical form (post-`normalizeMarkupPlaceholders`),
 * so a key counts as used when it appears as `{key}` or as the argument of an
 * ICU slot (`{key, plural, …}`). Surrounding whitespace is tolerated.
 */
export function findUnusedParamKeys(texts: string[], params: Record<string, unknown> | undefined): string[] {
    if (!params) return [];
    const keys = Object.keys(params);
    if (!keys.length || !texts.length) return keys;

    const haystack = texts.join('\u0000');
    return keys.filter((key) => !new RegExp(`\\{\\s*${escapeForRegExp(key)}\\s*[,}]`).test(haystack));
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
 * Collect the argument names of every `select` in an ICU AST, including
 * selects nested inside other plural/select branches.
 *
 * Select nodes and plural nodes both carry `options`; only plural (and
 * `selectordinal`) nodes carry `pluralType`, so that field is what tells them
 * apart. Structural rather than a numeric type check so we don't depend on
 * `@formatjs`'s TYPE enum, which we don't declare as a dependency.
 */
function collectSelectArgs(nodes: readonly IcuNode[], into: Set<string>): Set<string> {
    for (const node of nodes) {
        if (!node.options) continue;
        if (node.pluralType === undefined && typeof node.value === 'string') into.add(node.value);
        for (const branch of Object.values(node.options)) collectSelectArgs(branch.value ?? [], into);
    }
    return into;
}

/**
 * Fill in `'other'` for every `select` argument the caller didn't provide.
 *
 * The ICU promoter in langsys-ai introduces a select argument the source
 * phrase never had — `{name}` in the source becomes a `{name_gender, select,
 * …}` branch in the gendered target locales — so an app that doesn't know its
 * user's gender has no way to supply it. Without this, that case degrades
 * badly and *only in the gendered locales*: `intl-messageformat` throws
 * `MissingValueError` and we fall through to simple interpolation, which
 * renders the raw ICU markup to the user. Defaulting to `other` yields the
 * neutral branch, which is the correct sentence for an app with no gender
 * data. (The PHP ports have the same guard for the same reason, except
 * ext-intl fails by echoing `{argName}` rather than throwing.)
 *
 * Explicitly-passed values are never touched, and an unrecognized value
 * already lands on `other` under ICU's own select semantics.
 */
function withSelectDefaults(
    ast: readonly IcuNode[],
    params: Record<string, unknown>,
    template: string,
    locale: string,
): Record<string, unknown> {
    const selectArgs = collectSelectArgs(ast, new Set<string>());
    if (selectArgs.size === 0) return params;
    let filled: Record<string, unknown> | null = null;
    const defaulted: string[] = [];
    for (const arg of selectArgs) {
        if (params[arg] !== undefined && params[arg] !== null) continue;
        filled ??= { ...params };
        filled[arg] = 'other';
        defaulted.push(arg);
    }
    if (defaulted.length) warnDefaultedSelectArgs(defaulted, template, locale);
    return filled ?? params;
}

/** Templates already warned about, so a re-render doesn't re-log. */
const warnedSelectTemplates = new Set<string>();

/**
 * Debug-time notice that we filled in a `select` argument the caller didn't
 * pass — the discovery mechanism for a parameter no one wrote down.
 *
 * `withSelectDefaults` is deliberately silent about it in production: the
 * neutral branch is a correct sentence, so there is nothing for an end user to
 * see. But that same silence means a developer can never learn the argument
 * exists — it isn't in the source phrase (the promoter adds it only to the
 * locales whose grammar needs agreement), so nothing in the codebase hints at
 * it. Without this warning, the fallback makes the gendered case invisible
 * rather than merely graceful.
 *
 * Deduped per template+locale: `interpolate` runs on every render, and a list
 * of fifty rows re-rendering on a locale switch would otherwise emit fifty
 * identical lines.
 */
function warnDefaultedSelectArgs(args: string[], template: string, locale: string): void {
    if (!logger.debugEnabled) return;

    const key = `${locale}\n${template}`;
    if (warnedSelectTemplates.has(key)) return;
    warnedSelectTemplates.add(key);

    logger.warn(
        `The ${locale} translation branches on ${args.join(', ')}, which the source phrase does not have —` +
            ` this locale inflects for gender. Langsys used the "other" branch, which reads correctly for anyone.` +
            ` Pass ${args[0]} ("male" | "female" | "other") to get the inflected sentence instead.` +
            ` [${template}]`,
    );
}

/**
 * Substitute placeholders in a translated string with values from `params`.
 *
 * Two paths:
 *   - ICU MessageFormat (target string contains `{var, plural|select|…, …}`):
 *     parsed and formatted via `intl-messageformat`, which knows every
 *     target locale's plural rules (Arabic's 6 categories, Russian's 4,
 *     etc.) and gender-select branches. Missing select arguments fall back to
 *     the `other` branch — see `withSelectDefaults`.
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
            const resolved = locale || 'en';
            const message = new IntlMessageFormat(template, resolved);
            return message.format(
                withSelectDefaults(message.getAst() as IcuNode[], params, template, resolved),
            ) as string;
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
