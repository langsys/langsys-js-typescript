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
 * `<template>` is named as intent and is NOT a vector HERE: its content lives on
 * `HTMLTemplateElement.content`, so a walker over `childNodes` never reaches it
 * and omitting it from this list changes nothing in a DOM or in parse5 — two
 * lanes measured that independently. It is load-bearing elsewhere, which is why
 * it stays named: libxml2 puts `<template>` children in the ordinary tree, so a
 * PHP or Ruby walker that omitted it registers the template's text, and Ruby
 * measured exactly that leak. 8.0.1 states the split rather than calling the
 * exclusion free.
 *
 * `<math>` is notation, not prose. Translating a variable name or an operator
 * corrupts the expression instead of localising it, and before this exclusion
 * `<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>` tokenized to
 * `['Area','x','+','2','units']` — the operator and the bare variable registered
 * as translatable phrases and sent for machine translation. Added by spec 8.0.1
 * after v8 shipped without it.
 *
 * `<svg>` IS DELIBERATELY ABSENT and must stay absent. It is the exclusion people
 * expect that is wrong: an `<svg><text>` renders visible words to a reader, so its
 * text is translated like any other. 8.0.1 states that behaviourally because the
 * structural reading — "walk `<svg>` as a block" — regressed the commonest markup
 * there is when PHP implemented it: treating svg as a block dropped the PARENT's
 * direct text, so `<p>Click <svg><path/></svg> to continue</p>` registered nothing
 * and every icon-bearing heading, link and list item lost its words. Adding `svg`
 * here would reproduce that, which is what `tokenizer-convergence` now pins.
 */
export const NON_TRANSLATABLE_ELEMENTS = ['script', 'style', 'template', 'noscript', 'math'];

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
 * A producer's statement that text inside this element is ALREADY RESOLVED: rendered by
 * a server SDK in the visitor's language, not authored as source. A reader records no
 * miss for it — neither a registration nor a discovery hint — because the catalog is
 * keyed by source text and this is a translation.
 *
 * Distinct from the identity markers on purpose, and agreed that way with the PHP and
 * Laravel lanes. A MARK stamp answers "which block is this", and a stamped block inside a
 * resolved scope keeps its id and still translates on a later render; this attribute says
 * only "never treated as source". It is also not `translate="no"`, which tells a browser
 * not to machine-translate and would block a legitimate later render.
 *
 * The value is the locale it was resolved into, canonical lowercase, and is informational:
 * presence decides. A bare attribute means the same, because a binding writing it into a
 * layout often does not know the locale at that point. `="false"` and `="0"` opt a subtree
 * back out, the convention `isPhraseMarked` already uses in both SDKs; `="no"` and
 * `="off"` are NOT opt-outs under that shared rule.
 */
export const RESOLVED_MARKER_ATTR = 'data-ls-resolved';

/** PHP's spelling, accepted on read for the same reason the other markers' is (MARK-2). */
export const RESOLVED_MARKER_ATTR_LEGACY = 'data-langsys-resolved';

export const RESOLVED_MARKER_ATTRS = [RESOLVED_MARKER_ATTR, RESOLVED_MARKER_ATTR_LEGACY] as const;

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
 *
 * It lives HERE, beside `normalizeTokenText`, because it decides a stored key:
 * every capture boundary runs it, so the same authored content must pass through
 * the same rewrite in every SDK or the key splits. It was in `interpolate.ts`,
 * which is where the RENDER-time counterpart belongs, and where its docstring
 * had drifted onto `adoptPercentPlaceholders` — two functions with one doc
 * between them. `interpolate.ts` re-exports it, so no importer moves.
 */
export function normalizeMarkupPlaceholders(text: string): string {
    return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, '{$1}');
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

/**
 * One node of a rich-phrase tree, in the host-neutral shape `encodeRichPhrase`
 * walks.
 *
 * `{ text }` carries a text node's value VERBATIM — uncollapsed, untrimmed,
 * because collapse runs once over the assembled string and not per node (see
 * `encodeRichPhrase`). An element contributes its `children` plus an opaque
 * `payload` handed straight back in `slots`, so a host keeps its own node handle
 * without this module knowing what one is.
 *
 * Anything that is NEITHER text nor element — a comment, a CDATA section, a
 * processing instruction — must contribute NO text and NO slot. The DOM adapter
 * drops them outright.
 *
 * Measured, because the obvious wording here was wrong: mapping one to
 * `{ text: '' }` is HARMLESS (`'a' + '' + 'b'` is still `'ab'`), so an adapter may
 * do that freely. What splits the key is mapping it to its own DATA
 * (`a<!-- note -->b` becoming `'a note b'`) or giving it a slot (`'a{m0o}{m0c}b'`,
 * which also shifts every later slot index). Those two are the mistakes worth
 * naming; "must be omitted" overstates the rule.
 */
export type RichTextNode<T> = { readonly text: string } | { readonly children: readonly RichTextNode<T>[]; readonly payload: T };

export interface EncodedRichPhrase<T> {
    /** The phrase string: the lookup key, and therefore the identity. */
    phrase: string;
    /** Each element's `payload`, in the order its markup token was assigned. */
    slots: T[];
}

/**
 * The `<Phrase>` identity rule, with no DOM in it.
 *
 * `<Phrase>` keys by a STRING, not by a token array and not by a `custom_id`:
 * inline elements become neutral `{mNo}`/`{mNc}` markup-token pairs and the
 * whole thing collapses to one sentence, which is then the catalog key. So this
 * string is as load-bearing as `generateCustomId`'s output, and a second
 * implementation of it re-keys every rich phrase the moment the two drift —
 * silently, as a cache miss and a re-registration rather than an error.
 *
 * That is why it is here and generic over the host's node type: `langsys-js-server`
 * renders `<Phrase>` from parse5 nodes and was otherwise going to write its own
 * encoder. The DOM adapter is `encodeRichText` in `richtext.ts`, which is now
 * nothing but a node-shape mapping over this function.
 *
 * Three details are identity and every adapter has to match them:
 *
 *  1. **Slot indices are assigned in pre-order**, parent before its children,
 *     which is why `slots` comes back from here rather than being built by the
 *     caller's walk. An adapter that numbered its own slots would have to
 *     independently reproduce this order, and a nested phrase is where it would
 *     not.
 *  2. **Whitespace collapses ONCE, over the assembled string**, markup tokens
 *     included — never per text node. `<p>a <em> b</em></p>` keeps the space
 *     before `b` inside the markers; a per-node trim moves it outside them and
 *     changes the key. This is the same mistake the attribute path made against
 *     the text path, which is what split `custom_id` between this SDK and PHP.
 *  3. **`%name%` normalizes after the collapse**, not before. The two orders
 *     happen to agree today (an identifier cannot contain whitespace, so no
 *     collapse creates or destroys a match) — stated because "it doesn't matter"
 *     is not something a second implementation can verify, while "this order" is.
 *
 * The whitespace collapse is `normalizeTokenText`, deliberately SHARED with the
 * token path so the disputed set (U+FEFF, U+0085, U+180E — see CONFORMANCE) has
 * one definition to change when the spec rules. That sharing is about the
 * whitespace set only: COALESCING adjacent text nodes stays opposite between the
 * two paths, on purpose, and `content-block.ts` says so from its side.
 */
export function encodeRichPhrase<T>(nodes: readonly RichTextNode<T>[]): EncodedRichPhrase<T> {
    const slots: T[] = [];
    const assembled = _encodeRichNodes(nodes, slots);
    return { phrase: normalizeMarkupPlaceholders(normalizeTokenText(assembled)), slots };
}

function _encodeRichNodes<T>(nodes: readonly RichTextNode<T>[], slots: T[]): string {
    let out = '';
    for (const node of nodes) {
        if ('text' in node) {
            out += node.text;
            continue;
        }
        // Index taken and payload pushed BEFORE recursing: pre-order.
        const index = slots.length;
        slots.push(node.payload);
        out += `{m${index}o}` + _encodeRichNodes(node.children, slots) + `{m${index}c}`;
    }
    return out;
}

const UNCATEGORIZED_SLOT = '__uncategorized__';

function sameTokenList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((token, i) => token === b[i]);
}

/**
 * CID-3: every historical id a block with this content could be stored under.
 * LOOKUP ONLY. Never register or emit any of these.
 *
 * The authoritative list is the fleet's shared legacy fixture (vendored as
 * `tests/fixtures/legacy-custom-id-reference.json`, blob dc555646), and every row
 * of it must resolve. That takes three families of shape:
 *
 *  1. the corrected hash over the PRE-FIX token list, which the published JS SDK
 *     registered from 0.6.0 to 0.6.2, before the duplicated `<option>` fix;
 *  2. the JS code-unit hash (`generateLegacyCustomId`, which does not coalesce its
 *     category), which published JS SDKs registered before 0.6.0;
 *  3. the PHP pipe-join form, `md5` over `[slot, ...phrases].join('|')`.
 *
 * An uncategorised block could have been written under several spellings of its
 * category. Python lists the code-unit hash under `''` and `'__uncategorized__'`;
 * PHP lists it under `''` and a genuine `null` from an untyped JS caller. The
 * fixture has a row for each, and the spec test is that every row resolves, so this
 * takes the UNION rather than either SDK's subset. The pipe-join form covers `''`
 * and `'__uncategorized__'`, which is all PHP ever wrote. Every extra candidate is
 * safe because none is attached without the CID-4 content check.
 *
 * Most likely first, de-duplicated, and never including the current id.
 */
export function historicalCustomIds(
    category: string | null | undefined,
    tokens: readonly string[],
    legacyTokens: readonly string[] = tokens
): string[] {
    const uncategorised =
        category === null || category === undefined || category === '' || category === UNCATEGORIZED_SLOT;
    const named = uncategorised ? '' : (category as string);
    const codeUnitSlots: Array<string | null> = uncategorised ? ['', UNCATEGORIZED_SLOT, null] : [named];
    const pipeSlots: string[] = uncategorised ? ['', UNCATEGORIZED_SLOT] : [named];
    const differ = !sameTokenList(tokens, legacyTokens);
    const lists: ReadonlyArray<readonly string[]> = differ ? [legacyTokens, tokens] : [tokens];

    const ids: string[] = [];
    if (differ) ids.push(generateCustomId(named, [...legacyTokens]));
    for (const list of lists) {
        for (const slot of codeUnitSlots) {
            ids.push(generateLegacyCustomId(slot as string, [...list]));
        }
    }
    for (const list of lists) {
        for (const slot of pipeSlots) {
            ids.push(md5([slot, ...list].join('|')));
        }
    }
    const current = generateCustomId(named, [...tokens]);
    return [...new Set(ids)].filter((id) => id !== current);
}

/**
 * CID-4: whether a block found under a historical id holds THIS block's content.
 *
 * None of the historical id spaces is injective. The UTF-16 packing loses a byte at
 * every fourth position, and joining on an unescaped delimiter loses the field
 * boundary, so an id alone does not identify a block, and attaching on the id being
 * present can file one block's translations under another.
 *
 * Compared as normalised for hashing, not as stored: a phrase stored by an older SDK
 * may carry whitespace or a `%name%` spelling that today's tokenizer canonicalises,
 * and a raw comparison would decline those correct matches. Compared as SETS, which
 * the rule allows where the representation has lost order, and the catalog returns a
 * block as a map keyed by source phrase. A set still defeats every collision mode,
 * since each is a collision over DIFFERING content. Matches langsys-python.
 */
export function blockContentMatches(storedPhrases: Iterable<string>, tokens: readonly string[]): boolean {
    const canonical = (phrase: string) => normalizeMarkupPlaceholders(normalizeTokenText(phrase));
    const stored = new Set(Array.from(storedPhrases, canonical));
    const current = new Set(tokens.map(canonical));
    if (stored.size !== current.size) return false;
    for (const phrase of stored) if (!current.has(phrase)) return false;
    return true;
}

