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
 * THE TWO WALKERS ARE NOT HERE, and deliberately so: `tokenizeElement` and
 * `encodeRichText` read real DOM nodes, which has no meaning without a document.
 * What is exported instead is everything they are built FROM — the attribute
 * list, the skip list, the per-token text normaliser, the placeholder rewriter,
 * the hashing, and `encodeRichPhrase` (the whole `<Phrase>` encoding over a
 * host-neutral node shape) — so a server that does its own parsing produces
 * byte-identical keys without reimplementing a rule.
 *
 * The line between the two is worth stating, since it is not "DOM-free parts
 * only": for the content-block path the walk itself is identity (token arity and
 * order), so a host must reproduce it against the exported rules. For `<Phrase>`
 * the walk is NOT identity — only the string it assembles is — so the whole
 * encoder travels, generic over the host's node type, and the host supplies just
 * a node-shape mapping.
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
    // <Phrase> identity — the string IS the key, so the encoder is shared
    encodeRichPhrase,
    // What the tokenizer is built from
    normalizeTokenText,
    stripC0Controls,
    normalizeMarkupPlaceholders,
    TRANSLATABLE_ATTRIBUTES,
    NON_TRANSLATABLE_ELEMENTS,
    // Markers, both spellings, read by either SDK
    PHRASE_MARKER_ATTR,
    PHRASE_MARKER_ATTR_LEGACY,
    PHRASE_MARKER_ATTRS,
    CONTENT_BLOCK_MARKER_ATTR,
    CONTENT_BLOCK_MARKER_ATTR_LEGACY,
    CONTENT_BLOCK_MARKER_ATTRS,
    // A producer's "already resolved" mark: never treated as source, never registered
    RESOLVED_MARKER_ATTR,
    RESOLVED_MARKER_ATTR_LEGACY,
    RESOLVED_MARKER_ATTRS,
} from './identity.js';

export { canonicalizeLocale, maximizedLangScript } from './locale.js';

export { findUnusedParamKeys, interpolate, isICU } from './interpolate.js';

export { md5, md5Legacy, isEmpty } from './utils.js';

// Legacy-key migration: the conversion decides the registered phrase, so every
// JS entry point converts through these rather than a copy (MIG-4, MIG-7).
export {
    LEGACY_FORMATS,
    SUPPORTED_LEGACY_FORMATS,
    convertLegacyCall,
    convertLegacyPluralForms,
    convertLegacyValue,
} from './legacy-value.js';
export { LegacyFormatError, createLegacyKeys } from './legacy-keys.js';
export type { LegacyConversion, LegacyEntryPoint, LegacyFormat } from './legacy-value.js';
export type { LegacyKeyFile, LegacyKeyHit, LegacyKeyProblem, LegacyKeys } from './legacy-keys.js';

// Catalog snapshots: the one file format every SDK writes and reads (SNAP-1).
// Loading one into the SDK is `LangsysApp.loadSnapshot`, on the main entry.
export {
    SNAPSHOT_FORMAT,
    SNAPSHOT_VERSION,
    SnapshotError,
    buildSnapshot,
    canonicalSnapshotJson,
    parseSnapshot,
    snapshotChecksum,
} from './snapshot.js';
export type { CatalogSnapshot, SnapshotCatalog, SnapshotCategory, SnapshotPayload, SnapshotRefusal } from './snapshot.js';

// Server messages: finding entries in a response and the template grammar.
// Rendering one needs `t()`, so `renderServerMessage` is on the main entry only.
export {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    SERVER_MESSAGE_CODES,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    toServerMessage,
} from './server-messages.js';

export type { EncodedRichPhrase, RichTextNode } from './identity.js';
export type { ParamPrimitive, TranslationParams } from './types/translation-fn.js';
export type { iContentBlock } from './types/content-block.js';
