import { md5, md5Legacy } from './utils.js';

/**
 * The IDENTITY CONTRACT — everything that decides a `custom_id`, with no DOM
 * and no module-scope side effects, so it can be imported from a server, a
 * worker or a build script.
 *
 * It lives apart from `content-block.ts` because that module reaches the API
 * client, the discovery lane and the persisted stores; importing it to hash a
 * string pulled a network client and a storage probe along. `langsys-js-server`
 * was sed-extracting these functions out of a published tarball under
 * `@ts-nocheck` for exactly that reason — a copy that silently predates every
 * id rule changed since. Re-exported by `content-block.ts`, so nothing that
 * already imports from there needs to move.
 *
 * Reachable as the `langsys-js-typescript/pure` subpath. Nothing here may touch
 * `window`, `document`, `navigator` or storage, at import time or on any call
 * path — `tests/pure-subpath.test.ts` enforces that under a trapping global.
 */

/**
 * HTML attributes whose values should be harvested for translation.
 *
 * THE LIST IS NOW IDENTICAL TO `langsys-php`'s, all twenty-seven, in its order.
 *
 * It used to be a subset of fifteen, and this docstring used to argue that the
 * framework-convention attributes (Bootstrap `data-bs-*`, Rails `data-confirm`)
 * were deliberately not mirrored because a JS app renders those strings through
 * its own components. That reasoning is superseded and was left standing beside
 * the list that contradicted it — the twelve below are exactly the attributes it
 * said would never appear here.
 *
 * The reason it was wrong: on an SSR handoff the two SDKs tokenize the SAME
 * markup, so an attribute only one side harvests produces a different token
 * array and therefore a different `custom_id` for identical content. That is not
 * a coverage hole to be argued about, it is a split identity.
 *
 * ORDER IS IDENTITY. `custom_id` hashes the token array, and where an element
 * carries several of these the list order decides the sequence. The same set in
 * a different order agrees on every single-attribute element and diverges on
 * exactly the ones nobody notices, so the twelve are APPENDED — inserting would
 * have re-keyed every block using one of the original fifteen.
 */
export const TRANSLATABLE_ATTRIBUTES = [
    'placeholder',
    'alt',
    'title',
    'label', // <option>, <optgroup>, <track> — the text a user reads in the picker
    'aria-label',
    'aria-placeholder',
    'aria-description',
    'aria-valuetext', // the spoken value of a slider/meter
    'aria-roledescription',
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
    // The 12 below converge on langsys-php's list, verified against
    // `src/Html/HtmlParser.php` rather than taken on report. ORDER IS IDENTITY:
    // `custom_id` hashes the token array, so these must stay appended in PHP's
    // order — reordering them silently re-keys every block using one.
    'data-confirm', // Rails-style confirmation dialogs
    'data-tooltip',
    'data-title',
    'data-content',
    'data-original-title', // Bootstrap 4 tooltip/popover
    'data-bs-title', // Bootstrap 5
    'data-bs-content',
    'data-loading-text',
    'data-success-message',
    'data-warning-message',
    'data-empty-message',
    'data-placeholder', // editors that shadow the native attribute
];

/**
 * Elements holding code, inert content, or content no implementation can agree
 * on. Measured before this existed: `<style>.plan{color:#fff}</style>`
 * registered `.plan{color:#fff}` as a translatable phrase, and
 * `<script>window.dataLayer.push(1)</script>` registered the statement. Both
 * were then sent for machine translation.
 *
 * `<noscript>` IS HERE ON A REVERSAL, and the reasoning is worth keeping because
 * the obvious answer is the wrong one. An earlier reading excluded it from this
 * list: its text renders to a real visitor whenever scripting is off, so
 * skipping it would leave a visitor-visible sentence permanently untranslated.
 * That premise is true, and it does not survive two questions.
 *
 *  - WHO COULD TRANSLATE IT. With scripting off, a browser SDK is not running,
 *    so it can translate nothing on that page — including this.
 *  - WHAT THE TOKEN ACTUALLY IS. With scripting ENABLED, the spec's default, a
 *    parser makes a `noscript` body RAW TEXT rather than markup. Chromium and
 *    parse5 both yield the single token `<p>Enable JavaScript</p>`. Registering
 *    that sends MARKUP to machine translation, which is this family's own
 *    failure mode arriving through the rule meant to prevent it.
 *
 * And the implementations could not be made to agree cheaply. The axis is the
 * parser's scripting flag, not browser-versus-server: Chromium and parse5 agree
 * because parse5 defaults to scripting enabled, while PHP's libxml2 has no such
 * flag and parses the children as elements. `happy-dom` and `jsdom` behave like
 * libxml2, so a lane measuring in a test environment reproduces a
 * browser-versus-server split that does not exist.
 *
 * `<template>` is named as intent and is NOT a vector: its content lives on
 * `HTMLTemplateElement.content`, so a walker over `childNodes` never reaches it
 * and omitting it from this list changes nothing. Two lanes measured that
 * independently, in a DOM and in parse5.
 */
export const NON_TRANSLATABLE_ELEMENTS = ['script', 'style', 'template', 'noscript'];

/**
 * THE definition. `phrase.ts` re-exports this rather than restating it — the
 * literal used to appear in both files, so renaming one side left the other
 * silently stale: the tokenizer would stop recognising the marker `Phrase`
 * emits and would re-tokenize a subtree that manages itself.
 */
export const PHRASE_MARKER_ATTR = 'data-ls-phrase';

/** PHP's spelling. Recognised so a catalog shared with langsys-php round-trips. */
export const PHRASE_MARKER_ATTR_LEGACY = 'data-langsys-phrase';

export const PHRASE_MARKER_ATTRS = [PHRASE_MARKER_ATTR, PHRASE_MARKER_ATTR_LEGACY] as const;

/**
 * Marker the `Translate` host element carries, holding the resolved
 * `custom_id` of the block rendered inside it.
 *
 * Mirrors how a `Phrase` host carries `PHRASE_MARKER_ATTR`, and exists so a
 * server-rendered page can be read back: the id is otherwise derivable only by
 * re-running the tokenizer over the same subtree, which a reader that only has
 * the HTML cannot do identically.
 */
export const CONTENT_BLOCK_MARKER_ATTR = 'data-ls-contentblock';

/** PHP's spelling, accepted on read for the same reason the phrase marker's is. */
export const CONTENT_BLOCK_MARKER_ATTR_LEGACY = 'data-langsys-contentblock';

export const CONTENT_BLOCK_MARKER_ATTRS = [
    CONTENT_BLOCK_MARKER_ATTR,
    CONTENT_BLOCK_MARKER_ATTR_LEGACY,
] as const;

/**
 * Canonical form of one token's text, applied identically to a TEXT NODE and to
 * an ATTRIBUTE VALUE.
 *
 * It used to differ: text nodes collapsed internal whitespace while attributes
 * were only trimmed. So the same authored sentence produced two different ids
 * depending on where it sat —
 *
 *   <p>A long\n     description</p>        -> "A long description"
 *   <img alt="A long\n     description">   -> "A long\n     description"
 *
 * — which also put this SDK and `langsys-php` on different ids for the same
 * markup. One function now, used by both, so "the same content yields the same
 * id" is true by construction rather than by two call sites agreeing.
 *
 * `\s` in JavaScript already covers U+00A0, so a non-breaking space collapses
 * like any other whitespace without special handling.
 */
export function normalizeTokenText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Compute the deterministic content-block id from a `(category, tokens)` pair.
 *
 * JSON-stringifies the tuple so each token is unambiguously delimited
 * (the previous `tokens.join('-')` was collision-prone for tokens
 * containing a hyphen, e.g. `'e-mail'`).
 *
 * Pure function — same inputs always produce the same id. Exported so
 * framework wrappers can compute the id themselves before deciding
 * whether to call `registerContentBlock`.
 */
export function generateCustomId(category: string, tokens: string[]): string {
    // Coalesce at runtime, not just in the type. This is public API, so an
    // untyped or plain-JS caller can pass `undefined` — which serializes to
    // `[null, …]` and yields an id no wire path ever stores. Every shipping
    // caller already coalesces; this enforces "no-category is '', never null"
    // at the reference implementation rather than merely documenting it.
    //
    // `generateLegacyCustomId` deliberately does NOT do this: it must reproduce
    // what was actually stored, including ids an untyped caller produced.
    return md5(canonicalContentBlockJson(category, tokens));
}

/**
 * The exact string whose UTF-8 bytes are hashed to produce a `custom_id`.
 *
 * Extracted so the cross-implementation assertion can compare the SAME bytes
 * the id function hashes, rather than a second expression that happens to look
 * the same. The PHP lane found four separate sites re-deriving their
 * serialization, one of them inside the test that was supposed to be checking
 * it — a parallel reimplementation agrees with itself, and would keep agreeing
 * after this function changed.
 *
 * Deliberately NOT re-exported from `src/index.ts`: this is the reference
 * implementation's internals, not public API. `generateCustomId` is the
 * contract.
 */
/**
 * CID-2's input prohibition, applied where the value enters the hash.
 *
 * No-category is `''` — never `null`, never `undefined`, and never the
 * `'__uncategorized__'` sentinel. That sentinel is a CACHE-LOOKUP namespace: it
 * names the bucket an uncategorised phrase lives in inside `sTranslations`, and
 * it is a natural thing for a caller to have in hand. Hashing it produces an id
 * no wire path stores.
 *
 * Found by comparing ids against `langsys-php` over a shared fixture: tokens
 * byte-identical, ids different, because PHP normalised the sentinel and this
 * SDK did not. PHP was conformant and this side was not. No internal caller ever
 * passed it — `Translate` destructures `const { category = '' }` — so no stored
 * id changes; the hole was in the public export, and `/pure` had just widened
 * the audience for it.
 */
function hashableCategory(category: string): string {
    return !category || category === '__uncategorized__' ? '' : category;
}

export function canonicalContentBlockJson(category: string, tokens: string[]): string {
    return JSON.stringify([hashableCategory(category), tokens]);
}

/**
 * The id this block would have had before the 0.6.0 MD5 fix.
 *
 * **Lookup only — never register under this.** Blocks registered by an older
 * SDK are keyed by it, so `Translate` falls back to it when the corrected id
 * misses, which keeps existing translations resolving instead of orphaning
 * them. Registering under it would keep minting ids from a hash that both
 * diverges across SDKs and can collide.
 *
 * Note the collision is a property of the FINAL hashed string, not the phrase:
 * `JSON.stringify` shifts every character's offset, so the same phrase pair can
 * collide standalone and not collide here — and changing `category` moves every
 * character into different lanes. Always reason at this level, not at `md5()`.
 *
 * @deprecated Migration aid; will be removed once catalogs have been rebased.
 */
export function generateLegacyCustomId(category: string, tokens: string[]): string {
    return md5Legacy(JSON.stringify([category, tokens]));
}
