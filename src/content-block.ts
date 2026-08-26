/**
 * Framework-agnostic content-block helpers.
 *
 * The DOM-mutating `Translate` class in `translate.ts` is one consumer of
 * these — it walks a live element, tokenizes it, registers the content
 * block, and mutates the same element in place. That model fits Svelte
 * and vanilla JS, where the SDK genuinely owns the DOM node.
 *
 * For React/Vue/Angular wrappers, mutating the DOM directly is an anti-
 * pattern — those frameworks own their rendered output. Wrappers should
 * import the helpers below to handle the framework-agnostic parts (token
 * discovery, content-block registration, dedup against the local cache)
 * and render translated content through their framework's native means.
 *
 * Wrapper pattern:
 *
 *   1. After mount, grab the rendered DOM via the framework's ref/binding.
 *   2. `const { tokens, content } = tokenizeElement(el);`
 *   3. `const customId = generateCustomId(category, tokens);`
 *   4. `if (!isContentBlockKnown(category, customId)) {`
 *      `    await registerContentBlock({ custom_id: customId, category, content, tokens, label });`
 *      `}`
 *   5. Subscribe to `sTranslations` + `currentlyLoadedLocale`; on change,
 *      look up each token via `Translations.lookupContent(category, customId, token)`
 *      and render via your framework's templating.
 */

import { LangsysAppAPI } from './api.js';
import { recordMissForDiscovery } from './discovery.js';
import { normalizeMarkupPlaceholders } from './interpolate.js';
import { logger } from './logger.js';
import { config as configStore, sTranslations, writeEnabled } from './stores.js';
import type { iContentBlock } from './types/content-block.js';
import type { iTranslations } from './types/translations.js';
import { md5, md5Legacy } from './utils.js';

/**
 * HTML attributes whose values should be harvested for translation.
 *
 * `langsys-php` harvests a superset of this list. The overlap is deliberate,
 * the difference is not accidental: standard attributes carrying user-visible
 * text belong in both SDKs, because on SSR handoff an attribute only one side
 * harvests is translated by that side and left untranslated by the other — a
 * coverage hole rather than a conflict. Framework-convention attributes
 * (Bootstrap `data-bs-*`, Rails `data-confirm`, and similar) are deliberately
 * NOT mirrored: they're written by server-rendered templates, and a JS app
 * renders those strings through its own components instead.
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
];

/**
 * Attributes that mark a subtree as a self-managed "keep-together" phrase,
 * which the block tokenizer must skip rather than split at tag boundaries.
 *
 * Two spellings, because two SDKs mark the same thing:
 *  - `data-ls-phrase` — set by this SDK's framework `<Phrase>` components.
 *  - `data-langsys-phrase` — `langsys-php`'s author-facing marker, which
 *    survives into `translatePage()` output.
 *
 * The distinction is invisible in normal use, but on SSR handoff there is only
 * ONE DOM: a page rendered by PHP and then hydrated by a JS SDK is walked by
 * both implementations, so this tokenizer has to recognise PHP's marker or it
 * re-tokenizes a subtree PHP deliberately kept whole. Recognising both is
 * additive — `data-langsys-phrase` never appears in DOM our components emit.
 */
export const PHRASE_MARKER_ATTRS = ['data-ls-phrase', 'data-langsys-phrase'] as const;

/**
 * True when an element opts out of translation entirely — it and its subtree
 * are skipped by the tokenizer.
 *
 * Mirrors `langsys-php`'s `HtmlParser::isTranslationExcluded()` exactly:
 *  - `translate="no"` — the HTML standard attribute, matched case-insensitively.
 *  - `data-notrans` — PHP's author-facing alias, for hosts whose templating
 *    strips unknown bare attributes or where `translate` collides with another
 *    tool. Presence is intent; an explicit `"false"`/`"0"` opts out of the
 *    opt-out, compared after trimming.
 *
 * Honoring PHP's alias matters for the same reason as the phrase marker: on SSR
 * handoff there is ONE DOM, and content an author marked "do not translate"
 * must not be extracted and registered by whichever SDK happens to walk it.
 *
 * Both this and `isPhraseMarked` trim before comparing. They briefly differed
 * — PHP's phrase check predated the trim its exclusion check gained — and the
 * gap was resolved by asking rather than tidying: mirror exactly, flag the
 * wart, let the owner decide. Divergence-by-tidying is the same failure class
 * as divergence-by-oversight, just better intentioned.
 */
export function isTranslationExcluded(element: Element): boolean {
    if ((element.getAttribute('translate') ?? '').toLowerCase() === 'no') return true;
    if (!element.hasAttribute('data-notrans')) return false;
    const value = (element.getAttribute('data-notrans') ?? '').trim().toLowerCase();
    return value !== 'false' && value !== '0';
}

/**
 * True when an element is marked as a self-managed phrase by either SDK.
 *
 * Presence alone means intent, like any boolean HTML attribute — but an
 * explicit `="false"` or `="0"` opts OUT, compared after trimming. Mirrors
 * `langsys-php`'s `isPhraseMarked()` exactly (same method name in both SDKs,
 * so the correspondence is checkable at a glance). Without the opt-out we
 * would skip a subtree the author had deliberately un-marked, and it would
 * then be translated by neither SDK.
 */
export function isPhraseMarked(element: Element): boolean {
    return PHRASE_MARKER_ATTRS.some((attr) => {
        if (!element.hasAttribute(attr)) return false;
        const value = (element.getAttribute(attr) ?? '').trim().toLowerCase();
        return value !== 'false' && value !== '0';
    });
}

export const VALUE_TRANSLATABLE_ELEMENTS = ['button'];
export const VALUE_TRANSLATABLE_INPUT_TYPES = ['submit', 'button'];

/**
 * Semantic CSS properties captured on the cloned content so translators
 * in the Translation Manager see the content styled the way end-users do.
 */
export const SEMANTIC_STYLE_PROPERTIES = [
    'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
    'text-transform', 'text-indent', 'text-shadow', 'white-space', '-webkit-font-smoothing',
    'color', 'background-color', 'background-image', 'background-position',
    'background-size', 'background-repeat',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'border-color', 'border-width', 'border-style',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'box-shadow', 'opacity', 'filter',
    'display', 'visibility', 'list-style', 'list-style-type',
    'cursor',
];

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
export function canonicalContentBlockJson(category: string, tokens: string[]): string {
    return JSON.stringify([category || '', tokens]);
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
 * True iff the local translations cache already has the content block
 * for the given `(category, customId)` — meaning the backend knows about
 * it and there's no need to re-register.
 *
 * The cache is keyed under `'__uncategorized__'` for null/empty categories,
 * matching the convention the server uses in its GET /translations response.
 */
export function isContentBlockKnown(category: string, customId: string): boolean {
    const cats = sTranslations.get();
    const lookupCat = category || '__uncategorized__';
    const cbData = cats[lookupCat]?.[customId];
    return typeof cbData === 'object' && cbData !== null;
}

/**
 * POST a content block to the backend, then stamp its custom_id into the
 * local translations cache so subsequent mounts in this session — and
 * subsequent reloads, since the cache is persisted — skip the POST.
 *
 * Mirrors the standalone-phrase path's cache writeback semantics. Respects
 * `key_type === 'write'`: read-only keys silently no-op (resolves with
 * `{ status: true }` so the caller can still render the cached translation).
 *
 * Errors are logged via the SDK's logger and returned as `{ status: false }`
 * — never thrown. Callers can decide whether to surface to UI or swallow.
 */
export async function registerContentBlock(
    contentBlock: iContentBlock,
): Promise<{ status: boolean; errors?: unknown[] }> {
    // Server-computed capability, never inferred from `key_type`. This is the
    // lane the discovery renderer depends on most: it exists for dynamic
    // content, which is disproportionately content blocks rather than bare
    // `t()` calls, and it runs with an `ip_write` key that a
    // `key_type === 'write'` test would have rejected outright.
    if (writeEnabled.get() !== true) {
        // Hand the page to the discovery lane instead of dropping it.
        //
        // Without this, a page whose untranslated content lives entirely in
        // multi-token `Translate` blocks is invisible to discovery: those
        // tokens resolve through `lookupContent`, which registers nothing, so
        // they never reach `t()` and never reach the miss recorder. The block
        // was only discovered when some unrelated `t()` call happened to miss
        // on the same page — and content blocks are disproportionately what the
        // renderer exists to find, so the gap was worst where it mattered most.
        //
        // Carries no phrase payload: the recorder takes the block's identity
        // only to dedup, and the hint itself is URL-only.
        recordMissForDiscovery(contentBlock.category, contentBlock.custom_id);

        if (configStore.debug) {
            logger.log('Skipping content block save (session is not write-enabled)', {
                writeEnabled: writeEnabled.get(),
                key_type: configStore.key_type || 'unknown',
            });
        }
        return { status: true };
    }

    try {
        const response = await LangsysAppAPI.createTranslatableItems([
            {
                type: 'content_block',
                custom_id: contentBlock.custom_id,
                category: contentBlock.category,
                content: contentBlock.content,
                label: contentBlock.label,
                phrases: contentBlock.tokens.map((phrase) => ({ phrase })),
            },
        ]);
        if (!response.status) {
            logger.error('Could not save content block', response.errors);
            return { status: false, errors: response.errors as unknown[] | undefined };
        }
        _writeKnownContentBlockToCache(contentBlock.category, contentBlock.custom_id);
        return { status: true };
    } catch (err) {
        logger.error('Could not save content block', err);
        return { status: false, errors: [err] };
    }
}

/**
 * Walk an `HTMLElement`, collecting tokens for translation and producing a
 * cloned-and-stylized snapshot of its outerHTML for the Translation Manager.
 *
 * Tokens harvested:
 *  - text-node content (whitespace-normalized, trimmed)
 *  - translatable attribute values (`placeholder`, `alt`, `title`, `aria-*`, etc.)
 *  - button/input/select value text
 *
 * Skips subtrees marked with `translate="no"`.
 *
 * The returned `content` is a string snapshot — the live element is not
 * mutated. Computed semantic styles (color, font, spacing, etc.) are inlined
 * onto the clone so translators see content styled the way end-users do.
 *
 * Requires that `element` is mounted in the document so `getComputedStyle`
 * can read its style. For SSR / pre-mount callers, the style capture step
 * silently no-ops and the snapshot is plain (without inlined styles).
 */
export function tokenizeElement(element: HTMLElement): { tokens: string[]; content: string } {
    const tokens: string[] = [];
    const clone = element.cloneNode(true) as HTMLElement;
    _walkForTokens(element, Array.from(clone.childNodes), tokens, [], false, true);
    return { tokens, content: normalizeMarkupPlaceholders(clone.outerHTML) };
}

/**
 * The token list this element would have produced before 0.6.3, when every
 * `<option>`'s text was harvested twice — once by a `<select>` special case and
 * again by the ordinary text-node walk.
 *
 * **Lookup only.** Content blocks registered by an older SDK are keyed by an id
 * derived from this list, so `Translate` falls back to it when the corrected id
 * misses; without that, every block containing a `<select>` would silently
 * re-key and lose its translations on upgrade. Registration always uses the
 * corrected list, so the legacy-keyed population can only shrink.
 *
 * Skips the computed-style capture that `tokenizeElement` performs — this is a
 * cache-key computation, not a snapshot for translators.
 *
 * @deprecated Migration aid; will be removed once catalogs have been rebased.
 */
export function legacyTokenizeElement(element: HTMLElement): string[] {
    const tokens: string[] = [];
    const clone = element.cloneNode(true) as HTMLElement;
    _walkForTokens(element, Array.from(clone.childNodes), tokens, [], true, false);
    return tokens;
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function _writeKnownContentBlockToCache(category: string, customId: string): void {
    const lookupCat = category || '__uncategorized__';
    sTranslations.update((current) => {
        if (!current[lookupCat]) {
            current[lookupCat] = {
                __category__: lookupCat,
                __symbol__: lookupCat,
            } as iTranslations;
        }
        (current[lookupCat] as unknown as Record<string, unknown>)[customId] = {};
        return { ...current };
    });
}

/**
 * IDENTITY CONTRACT — one token per text node. Do not coalesce.
 *
 * `generateCustomId` hashes `JSON.stringify([category, tokens])`, so the
 * ARITY of the token array is load-bearing, not just its concatenated text.
 * Three adjacent text nodes and one merged node with the same characters are
 * DIFFERENT content blocks.
 *
 * That makes "merge adjacent text nodes before tokenizing" — a `normalize()`
 * call, or a textual comment-strip that closes the gap between two runs — a
 * breaking change to a wire value shared by every Langsys SDK, disguised as a
 * tidy-up. It reviews well, passes any test that asserts on rendered output,
 * and silently re-keys every catalog in existence.
 *
 * Frameworks routinely split one authored sentence across several text nodes,
 * and — this is the part that makes the contract unconditional — **each one
 * gets there by a different route.** React renders `Hello {name}!` as three
 * nodes separated by `<!-- -->` comments that survive hydration (measured
 * here, `tests/content-block-identity.test.ts`). Svelte does NOT split on
 * interpolation — a contiguous run compiles to one text node updated via
 * `set_text` — but reaches the same exposure through block constructs, where
 * `{#each}` splits a run into separate nodes (measured by the Svelte
 * binding, not re-run here). Vue's mechanism is not known.
 *
 * So do not scope this contract to a framework, and do not conclude from one
 * binding's behaviour that coalescing is safe "for the others". Checking only
 * interpolation in Svelte would say Svelte is unaffected; checking `{#each}`
 * says otherwise. The invariant is about the token array, not about any
 * renderer.
 *
 * The comment handling below is part of the same contract. A comment is
 * neither `TEXT_NODE` nor `ELEMENT_NODE`, so the walk steps over it
 * structurally while leaving the text either side as separate nodes. Skip
 * comments by walking, never by regexing the HTML.
 *
 * SCOPE — this governs `_walkForTokens` and nothing else. The SDK has TWO
 * identity mechanisms with deliberately OPPOSITE text handling:
 *
 *   `_walkForTokens`  (Translate / content-block path)  one token per text
 *       node, never coalesced. Arity is identity.
 *   `encodeRichText`  (Phrase path, `src/richtext.ts`)  adjacent text nodes
 *       ARE concatenated and whitespace collapsed, into one phrase string.
 *       That string is the key — there is no token array and no `custom_id`
 *       on that path at all.
 *
 * Coalescing is the bug here and the requirement there. State the scope,
 * because the realistic failure is not someone getting `<Phrase>` wrong on
 * its own terms — it is someone who has just READ this contract finding
 * `encodeRichText` concatenating adjacent text, recognising it as the exact
 * defect they were warned about, and "fixing" it. A rule memorable enough to
 * be worth writing down is memorable enough to be misapplied to the wrong
 * path.
 *
 * Pinned by `tests/content-block-identity.test.ts`, which is mutation-checked:
 * adding `clone.normalize()` to `tokenizeElement` turns three of those tests
 * red. If you are here because one of them failed, the pinned literal is not
 * the thing to update — see `generateLegacyCustomId` for what an id change
 * actually costs.
 */
function _walkForTokens(
    liveRoot: HTMLElement,
    cloneNodes: ChildNode[],
    tokens: string[],
    indices: number[],
    duplicateSelectOptions: boolean,
    applyStyles: boolean,
): void {
    cloneNodes.forEach((node, index) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (isTranslationExcluded(el)) return;
            // A <Phrase> subtree is its own self-managed rich phrase — skip it
            // here so the content block doesn't tokenize its inner text.
            if (isPhraseMarked(el)) return;
        }

        if (applyStyles && node.hasChildNodes()) {
            _applyStylesToClone(liveRoot, node as HTMLElement, [...indices, index]);
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            _tokenizeAttributes(node as HTMLElement, tokens, duplicateSelectOptions);
        }

        const contentToken = node.nodeValue?.replace(/\s+/g, ' ').trim();
        if (node.nodeType === Node.TEXT_NODE && contentToken) {
            tokens.push(normalizeMarkupPlaceholders(contentToken));
            return;
        }

        if (!node.hasChildNodes()) return;
        _walkForTokens(liveRoot, Array.from(node.childNodes), tokens, [...indices, index], duplicateSelectOptions, applyStyles);
    });
}

function _tokenizeAttributes(element: HTMLElement, tokens: string[], duplicateSelectOptions: boolean): void {
    const tagName = element.tagName.toLowerCase();

    if (tagName === 'img') {
        const img = element as HTMLImageElement;
        if (img.src) element.setAttribute('src', img.src);
    }

    for (const attr of TRANSLATABLE_ATTRIBUTES) {
        const value = element.getAttribute(attr)?.trim();
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if (VALUE_TRANSLATABLE_ELEMENTS.includes(tagName)) {
        const value = element.getAttribute('value')?.trim();
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if (tagName === 'input') {
        const inputType = element.getAttribute('type')?.toLowerCase();
        if (inputType && VALUE_TRANSLATABLE_INPUT_TYPES.includes(inputType)) {
            const value = element.getAttribute('value')?.trim();
            if (value) tokens.push(normalizeMarkupPlaceholders(value));
        }
    }

    // <option> text is NOT harvested here in the current path: it arrives via
    // the ordinary text-node walk, since `<option>` cannot contain elements.
    // Doing both pushed every option's text TWICE, changing the token list and
    // therefore the block's `custom_id`. langsys-php reached the same
    // conclusion earlier — their `extractSelectOptions()` is an empty stub
    // with a comment saying so — and their token lists are the reference.
    //
    // The duplicate is reproduced ONLY for `legacyTokenizeElement`, so blocks
    // registered before 0.6.3 stay resolvable. `<optgroup label>` reaches us
    // through TRANSLATABLE_ATTRIBUTES either way.
    if (duplicateSelectOptions && tagName === 'select') {
        const options = element.querySelectorAll('option');
        options.forEach((option) => {
            const optionText = option.textContent?.trim();
            if (optionText) tokens.push(normalizeMarkupPlaceholders(optionText));
        });
    }
}

function _applyStylesToClone(liveRoot: HTMLElement, cloneNode: HTMLElement, indices: number[]): void {
    if (typeof window === 'undefined') return;
    const domNode = _findNode(Array.from(liveRoot.childNodes), indices);
    if (!domNode) return;

    const tagName = (domNode as HTMLElement).tagName.toLowerCase();
    const reference = document.createElement(tagName);
    reference.style.visibility = 'hidden';
    reference.style.position = 'absolute';
    document.body.appendChild(reference);

    const computed = window.getComputedStyle(domNode as HTMLElement);
    const defaults = window.getComputedStyle(reference);

    for (const prop of SEMANTIC_STYLE_PROPERTIES) {
        const value = computed.getPropertyValue(prop);
        const defaultValue = defaults.getPropertyValue(prop);
        if (value && value !== defaultValue) {
            cloneNode.style.setProperty(prop, value);
        }
    }

    document.body.removeChild(reference);
    cloneNode.removeAttribute('class');
}

function _findNode(nodes: ChildNode[], indices: number[]): Element | undefined {
    let currentNode: Node | undefined = nodes[indices[0]];
    for (let i = 1; i < indices.length; i++) {
        if (!currentNode || !currentNode.hasChildNodes()) return undefined;
        currentNode = Array.from(currentNode.childNodes)[indices[i]];
    }
    return currentNode as Element;
}
