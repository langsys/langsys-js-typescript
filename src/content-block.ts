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
import { normalizeMarkupPlaceholders } from './interpolate.js';
import { logger } from './logger.js';
import { config as configStore, sTranslations } from './stores.js';
import type { iContentBlock } from './types/content-block.js';
import type { iTranslations } from './types/translations.js';
import { md5 } from './utils.js';

/** HTML attributes whose values should be harvested for translation. */
export const TRANSLATABLE_ATTRIBUTES = [
    'placeholder',
    'alt',
    'title',
    'aria-label',
    'aria-placeholder',
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
];

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
    return md5(JSON.stringify([category, tokens]));
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
    if (configStore.key_type !== 'write') {
        if (configStore.debug) {
            logger.log(`Skipping content block save (API key is ${configStore.key_type || 'unknown'})`);
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
    _walkForTokens(element, Array.from(clone.childNodes), tokens, []);
    return { tokens, content: normalizeMarkupPlaceholders(clone.outerHTML) };
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

function _walkForTokens(
    liveRoot: HTMLElement,
    cloneNodes: ChildNode[],
    tokens: string[],
    indices: number[],
): void {
    cloneNodes.forEach((node, index) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (el.getAttribute('translate') === 'no') return;
            // A <Phrase> subtree is its own self-managed rich phrase — skip it
            // here so the content block doesn't tokenize its inner text.
            if (el.hasAttribute('data-ls-phrase')) return;
        }

        if (node.hasChildNodes()) {
            _applyStylesToClone(liveRoot, node as HTMLElement, [...indices, index]);
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
            _tokenizeAttributes(node as HTMLElement, tokens);
        }

        const contentToken = node.nodeValue?.replace(/\s+/g, ' ').trim();
        if (node.nodeType === Node.TEXT_NODE && contentToken) {
            tokens.push(normalizeMarkupPlaceholders(contentToken));
            return;
        }

        if (!node.hasChildNodes()) return;
        _walkForTokens(liveRoot, Array.from(node.childNodes), tokens, [...indices, index]);
    });
}

function _tokenizeAttributes(element: HTMLElement, tokens: string[]): void {
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

    if (tagName === 'select') {
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
