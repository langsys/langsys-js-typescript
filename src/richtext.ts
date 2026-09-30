/**
 * Rich-text (markup-bearing) phrase encoding for the `<Phrase>` artifact.
 *
 * The problem: a phrase like `You have {n} <strong>reviews</strong>` must stay
 * ONE phrase (so pluralization sees `{n}` next to `reviews`), but we must NOT
 * send the SPA's real markup — and especially not framework-internal scoped-CSS
 * classes (`svelte-a1b2c3`, Vue scoped hashes) — to the translator. Those
 * classes get mangled, and worse they change on every build, which would make
 * the phrase key drift and silently re-translate everything.
 *
 * The approach: replace each inline element with a pair of neutral MARKUP
 * TOKENS — `{m0o}` ... `{m0c}` (markup, slot 0, open/close). These are ordinary
 * ICU placeholders: valid MessageFormat argument names, so plural/select still
 * parse, and the model treats them like `{n}` — it preserves them and PLACES
 * them around the translated word (which is what fixes reordering languages,
 * e.g. `<span>White</span> House` -> `Casa <span>Blanca</span>`).
 *
 * The real DOM elements never leave the SDK. At render time we resolve the
 * translation, substitute each markup token with a private-use SENTINEL char
 * (transient — never sent anywhere), then reconstitute the DOM by wrapping the
 * sentinel-delimited spans in the ORIGINAL framework-owned elements. Scoped CSS
 * survives because we reuse the real element; the phrase key is stable because
 * the wire form only ever contains `{m0o}`/`{m0c}`, never build-specific hashes.
 */

// Private-use (PUA) sentinel delimiters, written via char codes so no literal
// PUA characters live in the source. Brace-free so ICU MessageFormat treats a
// substituted sentinel as literal text. They exist only transiently at render —
// never registered, never sent over the wire (the wire form uses {mNo}/{mNc}).
//   open(i)  = U+E000  <i>  U+E001
//   close(i) = U+E002  <i>  U+E003
import { encodeRichPhrase } from './identity.js';
import { paramElementName, toRichNodes, type MarkerNode } from './var-markers.js';

const SENT_OPEN_START = String.fromCharCode(0xe000);
const SENT_OPEN_END = String.fromCharCode(0xe001);
const SENT_CLOSE_START = String.fromCharCode(0xe002);
const SENT_CLOSE_END = String.fromCharCode(0xe003);

/** Matches an open marker (group 1 = slot index) or a close marker (group 2 = slot index). */
const SENT_SCAN = /\uE000(\d+)\uE001|\uE002(\d+)\uE003/g;

/** A captured inline element: a shallow clone (tag + attributes, no children). */
export interface RichSlot {
    /** Shallow clone of the original element — preserves tag, class, href, etc. */
    template: HTMLElement;
}

export interface EncodedRichText {
    /**
     * The phrase string with inline elements replaced by `{mNo}`...`{mNc}` markup
     * tokens. This is what gets registered + sent for translation.
     */
    phrase: string;
    /** Captured inline elements, indexed by markup-token slot number. */
    slots: RichSlot[];
    /** Each marked value, by name (VAR-3): the params the phrase renders with, unless the caller names them. */
    values: Record<string, string>;
}

/**
 * Walk an element's subtree and produce the encoded phrase + captured slots.
 *
 * Text nodes contribute their (whitespace-collapsed) text. Each child element
 * becomes a markup-token pair wrapping its recursively-encoded contents, and a
 * shallow clone of the element is captured as a slot. Nesting is preserved.
 *
 * COALESCING ADJACENT TEXT NODES IS CORRECT HERE — do not "fix" it.
 *
 * `_encodeNodes` concatenates adjacent text nodes and this function collapses
 * whitespace, producing ONE phrase string. That string is the lookup key:
 * `Phrase` calls `Translations.t(phrase, category)` and never computes a
 * `custom_id`. A sentence must survive the round trip whole — that is the
 * entire reason `<Phrase>` exists, since splitting `Based on {n}
 * <strong>reviews</strong>` into fragments makes correct agreement impossible
 * in languages with more than two plural forms.
 *
 * The `_walkForTokens` contract in `content-block.ts` says the OPPOSITE, for
 * the content-block path, where token-array arity is identity. Both are right
 * for their own path. If you arrived here from that comment intending to make
 * this consistent with it, the paths are not meant to agree.
 *
 * Pinned by `tests/content-block-identity.test.ts` ("Phrase path"), which
 * fails if this coalescing is removed.
 */
export function encodeRichText(root: HTMLElement): EncodedRichText {
    // The encoding itself — slot numbering, whitespace collapse, `%name%`
    // normalization — is `encodeRichPhrase` in `identity.ts`, shared with every
    // host that renders `<Phrase>`. What is left here is the only DOM-shaped
    // part: turning child nodes into the host-neutral shape it walks.
    //
    // Split because the phrase string IS the catalog key. `langsys-js-server`
    // renders `<Phrase>` from parse5 nodes and had no way to import this, so the
    // alternative was a second encoder, and two encoders of one key drift into a
    // silent re-registration rather than an error.
    const values: Record<string, string> = {};
    // Shallow clone: tag + attributes, no children. Preserves the framework's
    // scoped-CSS class, which is the whole point of reusing the real element at
    // reconstitution. A marked value is its placeholder, and its value a param (VAR-3).
    const nodes = toRichNodes(root.childNodes as unknown as ArrayLike<MarkerNode>, (element) => (element as unknown as HTMLElement).cloneNode(false) as HTMLElement, values);
    const { phrase, slots } = encodeRichPhrase(nodes);
    return { phrase, slots: slots.map((template) => ({ template })), values };
}


/**
 * The param values to feed alongside the user's params when resolving a rich
 * phrase. Each markup token maps to its sentinel pair so the resolved string
 * carries machine-findable delimiters for reconstitution.
 */
export function markupTokenValues(slotCount: number): Record<string, string> {
    const values: Record<string, string> = {};
    for (let i = 0; i < slotCount; i++) {
        values[`m${i}o`] = `${SENT_OPEN_START}${i}${SENT_OPEN_END}`;
        values[`m${i}c`] = `${SENT_CLOSE_START}${i}${SENT_CLOSE_END}`;
    }
    return values;
}

/**
 * Rebuild DOM nodes from a resolved string containing sentinel-delimited spans.
 *
 * The original (framework-owned) elements are reused as wrappers — so scoped
 * CSS classes / attributes survive — with the translated text placed inside.
 *
 * Robust to model mistakes: if sentinels are unbalanced (a tag dropped or a
 * stray close), we fall back to a single plain-text node (markers stripped) —
 * "lose the markup, keep the meaning" rather than throw.
 */
/**
 * Split a resolved string into its text runs and markup-token opens and closes,
 * or null when they do not nest. The one reading of the sentinels, shared by
 * `applyInPlace` and `reconstitute`.
 */
export function splitSentinels(resolved: string): Array<{ text: string } | { open: number } | { close: number }> | null {
    const parts: Array<{ text: string } | { open: number } | { close: number }> = [];
    let depth = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const scan = new RegExp(SENT_SCAN.source, 'g');
    while ((match = scan.exec(resolved)) !== null) {
        const text = resolved.slice(lastIndex, match.index);
        if (text) parts.push({ text });
        lastIndex = scan.lastIndex;
        if (match[1] !== undefined) {
            parts.push({ open: Number(match[1]) });
            depth++;
        } else {
            if (depth === 0) return null;
            parts.push({ close: Number(match[2]) });
            depth--;
        }
    }
    const tail = resolved.slice(lastIndex);
    if (tail) parts.push({ text: tail });
    return depth === 0 ? parts : null;
}

/**
 * Write a resolved rich phrase into the host's EXISTING nodes, when its markup
 * skeleton is the host's: the same elements, in the same nesting and order.
 * Each text run goes into the host's text node at its place, and a text node the
 * translation has nothing for is emptied. Returns false, touching nothing, when
 * the skeleton differs (a translation that reorders, adds or drops inline
 * markup), and the caller then rebuilds the host.
 *
 * In place, because a reactive framework holds references to the nodes it
 * rendered: replacing them leaves every later update writing to a detached node
 * that is no longer on the page. Only a structural change has to replace them,
 * and then those later updates are lost, which is the cost of the reorder.
 *
 * `slotOf` names the markup slot each element renders. Without it, an element's
 * slot is its place among the host's elements, which holds only while the host
 * shows the source's order: after a translation that reorders its markup, or over
 * a served translation, the elements' places are not their slots.
 */
export function applyInPlace(host: Node, resolved: string, slotOf?: (element: Element) => number | undefined): boolean {
    const parts = splitSentinels(resolved);
    if (!parts) return false;
    const writes: Array<[Node, string]> = [];
    let next = 0;
    let slot = 0;
    const walk = (parent: Node): boolean => {
        for (const child of Array.from(parent.childNodes)) {
            if (child.nodeType === 3) {
                const part = parts[next];
                if (part && 'text' in part) {
                    writes.push([child, part.text]);
                    next++;
                } else {
                    writes.push([child, '']);
                }
            } else if (child.nodeType === 1 && paramElementName(child as unknown as MarkerNode) !== null) {
                // A marked value (VAR-3) is no slot: its value is in the resolved text.
                for (const text of Array.from(child.childNodes)) writes.push([text, '']);
            } else if (child.nodeType === 1) {
                const open = parts[next];
                const place = slot++;
                const index = slotOf ? slotOf(child as Element) : place;
                if (!open || !('open' in open) || open.open !== index) return false;
                next++;
                if (!walk(child)) return false;
                const close = parts[next];
                if (!close || !('close' in close) || close.close !== index) return false;
                next++;
            }
        }
        return true;
    };
    if (!walk(host) || next !== parts.length) return false;
    for (const [node, text] of writes) if (node.nodeValue !== text) node.nodeValue = text;
    return true;
}

export function reconstitute(
    resolved: string,
    slots: RichSlot[],
    doc: Document = document,
    onElement?: (element: HTMLElement, slot: number) => void
): Node[] {
    const root = doc.createDocumentFragment();
    const stack: Node[] = [root];
    const top = () => stack[stack.length - 1];

    let lastIndex = 0;
    let match: RegExpExecArray | null;
    SENT_SCAN.lastIndex = 0;

    try {
        while ((match = SENT_SCAN.exec(resolved)) !== null) {
            const text = resolved.slice(lastIndex, match.index);
            if (text) top().appendChild(doc.createTextNode(text));
            lastIndex = SENT_SCAN.lastIndex;

            const isOpen = match[1] !== undefined;
            const slotIndex = Number(isOpen ? match[1] : match[2]);

            if (isOpen) {
                const slot = slots[slotIndex];
                if (!slot) throw new Error('unknown markup slot');
                const el = slot.template.cloneNode(false) as HTMLElement;
                onElement?.(el, slotIndex);
                top().appendChild(el);
                stack.push(el);
            } else {
                if (stack.length <= 1) throw new Error('unbalanced close');
                stack.pop();
            }
        }

        const tail = resolved.slice(lastIndex);
        if (tail) top().appendChild(doc.createTextNode(tail));

        if (stack.length !== 1) throw new Error('unbalanced open');
    } catch {
        // Degrade gracefully: strip every marker and return plain text.
        return [doc.createTextNode(stripSentinels(resolved))];
    }

    return Array.from(root.childNodes);
}

/** Remove any sentinel markers from a string, leaving the bare text. */
export function stripSentinels(value: string): string {
    return value.replace(SENT_SCAN, '');
}
