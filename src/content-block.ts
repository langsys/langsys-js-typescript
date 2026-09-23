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
import { canonicalizeLocale } from './locale.js';
import { logger } from './logger.js';
import { catalogUnavailable, config as configStore, currentlyLoadedLocale, discoveryBaseLocaleOnly, sTranslations, writeEnabled } from './stores.js';
import type { iContentBlock } from './types/content-block.js';
import type { iTranslations } from './types/translations.js';
import {
    blockContentMatches,
    CONTENT_BLOCK_MARKER_ATTRS,
    NON_TRANSLATABLE_ELEMENTS,
    normalizeTokenText,
    PHRASE_MARKER_ATTRS,
    RESOLVED_MARKER_ATTRS,
    TRANSLATABLE_ATTRIBUTES,
} from './identity.js';

/**
 * The identity contract now lives in `identity.ts`, which has no DOM and no
 * module-scope side effects so a server can import it. Re-exported here because
 * this was its address for several releases and every binding imports from it.
 */
export {
    canonicalContentBlockJson,
    CONTENT_BLOCK_MARKER_ATTR,
    CONTENT_BLOCK_MARKER_ATTR_LEGACY,
    CONTENT_BLOCK_MARKER_ATTRS,
    generateCustomId,
    generateLegacyCustomId,
    NON_TRANSLATABLE_ELEMENTS,
    normalizeTokenText,
    PHRASE_MARKER_ATTR,
    PHRASE_MARKER_ATTR_LEGACY,
    PHRASE_MARKER_ATTRS,
    RESOLVED_MARKER_ATTR,
    RESOLVED_MARKER_ATTR_LEGACY,
    RESOLVED_MARKER_ATTRS,
    TRANSLATABLE_ATTRIBUTES,
} from './identity.js';


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

/**
 * True when an element is a content-block host: it carries `data-ls-contentblock` or PHP's
 * `data-langsys-contentblock` with any value other than `false` or `0` (MARK-3). A stamped id
 * and a bare declaration both count; `false` and `0` opt out, trimmed and case-insensitive —
 * the convention every marker attribute in the fleet shares.
 *
 * Such an element is a unit of its own, so an enclosing walk excises it (MARK-4): it
 * contributes no tokens to the enclosing block, the enclosing render does not write into it,
 * and it does not count toward the enclosing unit's single text node.
 */
export function isContentBlockMarked(element: Element): boolean {
    return CONTENT_BLOCK_MARKER_ATTRS.some((attr) => {
        if (!element.hasAttribute(attr)) return false;
        const value = (element.getAttribute(attr) ?? '').trim().toLowerCase();
        return value !== 'false' && value !== '0';
    });
}

/**
 * True when an element sits inside a scope a producer marked as already resolved.
 *
 * Inherited, and the NEAREST marked ancestor decides — so a document marked at `<html>`
 * can be opted back out of on a subtree with `="false"` or `="0"`. That inheritance is
 * what makes the attribute usable at all on the paths that need it: text a server printed
 * inline has no element of its own to carry a marker, so the only place a producer can
 * state the fact is an ancestor it does own, usually the document root.
 *
 * Both spellings are read (MARK-2), and the first marked ancestor's value decides even if
 * an outer one disagrees.
 */
export function isInResolvedScope(element: Element | null | undefined): boolean {
    let el: Element | null = element ?? null;
    while (el) {
        for (const attr of RESOLVED_MARKER_ATTRS) {
            if (!el.hasAttribute(attr)) continue;
            const value = (el.getAttribute(attr) ?? '').trim().toLowerCase();
            return value !== 'false' && value !== '0';
        }
        el = el.parentElement;
    }
    return false;
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
 * Resolve a content block under a historical id, verified on content.
 *
 * Walks `candidates` (from `historicalCustomIds`, most likely first) and returns the
 * first id whose stored block holds this block's phrases. A stored block whose
 * phrases differ is a collision, not a match, and is declined. A block cached by
 * this session's own registration is `{}` with no phrases to compare, so it can
 * never be verified and is declined as well.
 *
 * The failure direction is deliberate (CID-4): a false positive attaches the wrong
 * text, while a false negative silently restores nothing and looks like "this block
 * had no legacy id". So both outcomes are logged when debug is on, matching
 * langsys-python.
 */
export function resolveHistoricalBlockId(
    category: string,
    candidates: readonly string[],
    tokens: readonly string[]
): string | null {
    const bucket = sTranslations.get()[category || '__uncategorized__'] as unknown as Record<string, unknown> | undefined;
    if (!bucket) return null;
    for (const id of candidates) {
        const stored = bucket[id];
        if (typeof stored !== 'object' || stored === null) continue;
        if (!blockContentMatches(Object.keys(stored), tokens)) {
            if (configStore.debug) {
                logger.log(
                    `Historical content-block id ${id} resolved to a block whose phrases differ; declining it ` +
                        'rather than attaching to the wrong text.'
                );
            }
            continue;
        }
        if (configStore.debug) {
            logger.log(
                `Content block resolved under a historical id (${id}). Its translations still apply; it is never ` +
                    're-keyed and never registered under that id.'
            );
        }
        return id;
    }
    return null;
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
    // WIRE-4. After a failed catalog fetch every block looks unregistered, because
    // there is no catalog to find it in. Registering on that basis re-POSTs blocks
    // the backend already holds, on every page an outage touches. Record nothing,
    // on either lane: a discovery miss for a block that may well be registered is
    // the same mistake made read-only.
    if (catalogUnavailable.get()) {
        if (configStore.debug) {
            logger.log('Skipping content block registration: the catalog fetch failed, so an unknown block cannot be told from a registered one', {
                custom_id: contentBlock.custom_id,
            });
        }
        return { status: true };
    }

    // GATE-9 on the content-block path, as on the `t()` miss path: with the project setting
    // on, a block is neither registered nor reported unless the loaded locale is the base
    // locale. Before the first catalog publishes, the locale being requested stands in.
    if (discoveryBaseLocaleOnly.get()) {
        const loaded = currentlyLoadedLocale.get() || canonicalizeLocale(configStore.sUserLocale?.get() ?? '');
        if (loaded !== canonicalizeLocale(configStore.baseLocale || '')) {
            if (configStore.debug) {
                logger.log('Skipping content block: discovery is limited to the base locale', { custom_id: contentBlock.custom_id, loaded });
            }
            return { status: true };
        }
    }

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
            // Code, markup and notation — never prose. Measured before this guard
            // existed: `<style>.plan{color:#fff}</style>` registered
            // `.plan{color:#fff}` as a translatable phrase and
            // `<script>window.dataLayer.push(1)` registered the statement; later,
            // `<math>` registered its operators. All were then sent for machine
            // translation.
            //
            // The previous version of this comment said `<noscript>` was
            // "deliberately absent from that list", which had been false since
            // TOK-1 was reversed to exclude it — the reasoning left standing
            // beside a list that contradicted it, which is the same way the
            // attribute list's docstring went stale. The list is the contract;
            // see `NON_TRANSLATABLE_ELEMENTS` for why each member is in it and
            // why `<svg>` is not.
            if (NON_TRANSLATABLE_ELEMENTS.includes(el.tagName.toLowerCase())) return;
            // A <Phrase> subtree is its own self-managed rich phrase — skip it
            // here so the content block doesn't tokenize its inner text.
            if (isPhraseMarked(el)) return;
            // A nested content-block host is a unit of its own (MARK-4), whether stamped
            // with an id or declared by a bare marker, so its words are not this block's.
            // Without this they registered twice, once in each block, and the outer id
            // depended on the inner content.
            if (isContentBlockMarked(el)) return;
        }

        if (applyStyles && node.hasChildNodes()) {
            _applyStylesToClone(liveRoot, node as HTMLElement, [...indices, index]);
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            _tokenizeAttributes(node as HTMLElement, tokens, duplicateSelectOptions);
        }

        const contentToken = node.nodeValue ? normalizeTokenText(node.nodeValue) : undefined;
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

    // `normalizeTokenText`, not `.trim()`. Attributes used to keep their
    // internal whitespace while text nodes collapsed theirs, so the same
    // authored sentence produced two different ids depending on where it sat —
    // and put this SDK on different ids from langsys-php for the same markup.
    for (const attr of TRANSLATABLE_ATTRIBUTES) {
        const value = normalizeTokenText(element.getAttribute(attr) ?? '');
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if (VALUE_TRANSLATABLE_ELEMENTS.includes(tagName)) {
        const value = normalizeTokenText(element.getAttribute('value') ?? '');
        if (value) tokens.push(normalizeMarkupPlaceholders(value));
    }

    if (tagName === 'input') {
        const inputType = element.getAttribute('type')?.toLowerCase();
        if (inputType && VALUE_TRANSLATABLE_INPUT_TYPES.includes(inputType)) {
            const value = normalizeTokenText(element.getAttribute('value') ?? '');
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
            const optionText = normalizeTokenText(option.textContent ?? '');
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
