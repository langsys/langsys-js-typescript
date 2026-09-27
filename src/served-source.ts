import type { SeededBlock, SeededPhrase } from './block-tree.js';
import { tokenSlots, type TokenSlot } from './content-block.js';
import { normalizeMarkupPlaceholders, normalizeTokenText } from './identity.js';
import { interpolate } from './interpolate.js';
import { markupTokenValues, splitSentinels } from './richtext.js';
import { logger } from './logger.js';
import { activeCatalog } from './scope-context.js';
import { currentlyLoadedLocale } from './stores.js';
import type { ParamPrimitive } from './types/translation-fn.js';

/**
 * The source behind text a server already translated (SRV-4, GATE-10).
 *
 * A host a server rendered from the catalog carries the translation, not the
 * source, and the catalog is keyed by source. A client that read the DOM's text
 * as the key would render every later locale from the served one. So the DOM
 * classes over such a host take the source from where the server left it: the
 * scope's seed, which a binding hands over with `registerBlock(seededBlock)`
 * after `init()`, or, failing that, the catalog entry the served text was
 * rendered from. Never from the DOM.
 */

const seeded = new Map<string, SeededBlock>();
const collectedPhrases = new Set<string>();
let warnedUnrecovered = false;

/** Keep a seeded block's source tokens, by id, for the host that renders it. */
export function rememberSeededBlock(block: SeededBlock): void {
    if (block?.customId && Array.isArray(block.tokens)) seeded.set(block.customId, block);
}

/** Keep that the server's scope sends this phrase itself. */
export function rememberSeededPhrase(phrase: SeededPhrase): void {
    if (phrase?.collected && typeof phrase.phrase === 'string') collectedPhrases.add(`${phrase.category ?? ''}\0${phrase.phrase}`);
}

/** Whether the server's scope sends this phrase itself, so the client never records it for registration. */
export function isServerCollectedPhrase(category: string, phrase: string): boolean {
    return collectedPhrases.has(`${category ?? ''}\0${phrase}`);
}

/** Whether the server's scope sends this block itself, so the client never registers it. */
export function isServerCollected(customId: string): boolean {
    return seeded.get(customId)?.collected === true;
}

/** Test seam: forget every seeded block, and the warning given. */
export function _resetSeededBlocks(): void {
    seeded.clear();
    collectedPhrases.clear();
    warnedUnrecovered = false;
}

/** Said once: a served host whose source could not be recovered keeps its served text. */
export function warnUnrecoveredSource(): void {
    if (warnedUnrecovered) return;
    warnedUnrecovered = true;
    logger.warn(
        'A server-rendered block has no source to render other locales from: register the scope seed with registerBlock(seededBlock) after init(). It keeps the text it was served with.'
    );
}

const served = (value: string) => normalizeTokenText(normalizeMarkupPlaceholders(value));

/** What a slot holds now: the served token. */
function servedToken(slot: TokenSlot): string {
    return served(slot.attr ? (slot.node as Element).getAttribute(slot.attr) ?? '' : slot.node.nodeValue ?? '');
}

/**
 * The source token behind each of a block's slots, in slot order, or null when
 * they cannot all be recovered. From the seed when it holds the block with as
 * many tokens as the DOM has slots; else from the catalog entry under the id,
 * where exactly one source renders, with these params, as each slot's text:
 * translated, or as itself, since a block can be served in its source.
 */
export function recoverBlockSources(
    root: { childNodes: ArrayLike<Node> },
    customId: string,
    category: string,
    params: Record<string, ParamPrimitive>
): { slots: TokenSlot[]; sources: string[] } | null {
    const slots = tokenSlots(root.childNodes);
    if (slots.length === 0) return null;
    const seed = seeded.get(customId);
    if (seed && seed.tokens.length === slots.length) return { slots, sources: [...seed.tokens] };

    const entry = activeCatalog()[category || '__uncategorized__']?.[customId];
    if (!entry || typeof entry !== 'object') return null;
    const locale = currentlyLoadedLocale.get();
    const rendered = Object.entries(entry as unknown as Record<string, unknown>)
        .filter(([key]) => !key.startsWith('__'))
        .flatMap(([key, value]) => {
            const asSource = { key, text: served(interpolate(key, params, locale)) };
            if (typeof value !== 'string' || !value) return [asSource];
            return [asSource, { key, text: served(interpolate(value, params, locale)) }];
        });
    const sources: string[] = [];
    for (const slot of slots) {
        const text = servedToken(slot);
        const keys = new Set(rendered.filter((r) => r.text === text).map((r) => r.key));
        if (keys.size !== 1) return null;
        sources.push([...keys][0]!);
    }
    return { slots, sources };
}

/** A resolved rich phrase's text alone: markup gone, whitespace collapsed. */
const textOf = (value: string) =>
    normalizeTokenText(value.replace(/\uE000\d+\uE001|\uE002\d+\uE003/g, ' ').replace(/\{m\d+[oc]\}/g, ' '));

/**
 * The source phrase behind a served rich phrase, and, for each source markup
 * slot, which served slot holds its element; or null unless exactly one source in
 * the category renders, with these params, as the served text with as many
 * inline elements. A translation may reorder its markup, so the served elements
 * are mapped back to the source's slots by the order the translation opens them.
 */
export function recoverPhraseSource(
    servedPhrase: string,
    slotCount: number,
    category: string,
    params: Record<string, ParamPrimitive>
): { phrase: string; order: number[] } | null {
    const bucket = activeCatalog()[category || '__uncategorized__'];
    if (!bucket || typeof bucket !== 'object') return null;
    const locale = currentlyLoadedLocale.get();
    const target = textOf(servedPhrase);
    const values = { ...params, ...markupTokenValues(slotCount) };
    const found: Array<{ phrase: string; order: number[] }> = [];
    for (const [key, value] of Object.entries(bucket as unknown as Record<string, unknown>)) {
        if (key.startsWith('__') || (value !== null && typeof value === 'object')) continue;
        if ((key.match(/\{m\d+o\}/g) ?? []).length !== slotCount) continue;
        // Translated, or as itself: a phrase can be served in its source.
        const texts = typeof value === 'string' && value ? [value, key] : [key];
        for (const text of texts) {
            const resolved = interpolate(text, values, locale);
            if (textOf(resolved) !== target) continue;
            const parts = splitSentinels(resolved);
            const order = parts?.flatMap((part) => ('open' in part ? [part.open] : [])) ?? [];
            if (order.length !== slotCount) continue;
            if (!found.some((f) => f.phrase === key)) found.push({ phrase: key, order });
            break;
        }
    }
    return found.length === 1 ? found[0]! : null;
}
