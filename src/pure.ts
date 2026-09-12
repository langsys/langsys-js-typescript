/**
 * `langsys-js-typescript/pure` — the identity contract, with no DOM.
 *
 * Everything that decides a `custom_id`, a canonical locale, or the rendering of
 * a placeholder, importable from a server, a worker, an edge runtime or a build
 * script. Nothing here touches `window`, `document`, `navigator` or storage — at
 * import time or on any exported call path — and nothing here has a module-scope
 * side effect.
 *
 * It exists because `langsys-js-server` was otherwise reduced to
 * sed-extracting these functions out of a published tarball into a vendored
 * `@ts-nocheck` copy, since the main entry reaches the HTTP client and the
 * persisted stores. A copy cannot track a rule change: that one predated every
 * content-id decision made this month. Importing can.
 *
 * The TOKENIZER ITSELF IS NOT HERE, and deliberately so: `tokenizeElement` walks
 * real DOM nodes and reads computed styles, which has no meaning without a
 * document. What is exported instead is everything the walker is built FROM —
 * the attribute list, the skip list, the per-token text normaliser, the
 * placeholder rewriter and the hashing — so a server that does its own parsing
 * can produce byte-identical ids without reimplementing any of the rules.
 *
 * Enforced by `tests/pure-subpath.test.ts`, which imports this module in bare
 * Node under a `globalThis` Proxy that throws on any DOM-ish access, calls every
 * export, and pins the export list so a removal is a test failure rather than a
 * consumer's runtime error.
 */

export {
    // Content-block identity
    canonicalContentBlockJson,
    generateCustomId,
    generateLegacyCustomId,
    // What the tokenizer is built from
    normalizeTokenText,
    TRANSLATABLE_ATTRIBUTES,
    NON_TRANSLATABLE_ELEMENTS,
    // Markers, both spellings, read by either SDK
    PHRASE_MARKER_ATTR,
    PHRASE_MARKER_ATTR_LEGACY,
    PHRASE_MARKER_ATTRS,
    CONTENT_BLOCK_MARKER_ATTR,
    CONTENT_BLOCK_MARKER_ATTR_LEGACY,
    CONTENT_BLOCK_MARKER_ATTRS,
} from './identity.js';

export { canonicalizeLocale, maximizedLangScript } from './locale.js';

export { interpolate, isICU, normalizeMarkupPlaceholders } from './interpolate.js';

export { md5, md5Legacy, isEmpty } from './utils.js';

export type { ParamPrimitive, TranslationParams } from './types/translation-fn.js';
export type { iContentBlock } from './types/content-block.js';
