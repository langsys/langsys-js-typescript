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
import { normalizeMarkupPlaceholders } from './interpolate.js';

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
}

/**
 * Walk an element's subtree and produce the encoded phrase + captured slots.
 *
 * Text nodes contribute their (whitespace-collapsed) text. Each child element
 * becomes a markup-token pair wrapping its recursively-encoded contents, and a
 * shallow clone of the element is captured as a slot. Nesting is preserved.
 */
export function encodeRichText(root: HTMLElement): EncodedRichText {
    const slots: RichSlot[] = [];
    const phrase = _encodeNodes(Array.from(root.childNodes), slots);
    // `%key%` → `{key}` so the registered phrase carries the canonical
    // placeholder form (framework compilers eat bare `{key}` in markup).
    // The `{mNo}`/`{mNc}` markup tokens are generated brace-form and are
    // untouched by the normalization.
    return { phrase: normalizeMarkupPlaceholders(phrase.replace(/\s+/g, ' ').trim()), slots };
}

function _encodeNodes(nodes: ChildNode[], slots: RichSlot[]): string {
    let out = '';
    for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            out += node.nodeValue ?? '';
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const element = node as HTMLElement;
        const index = slots.length;
        slots.push({ template: element.cloneNode(false) as HTMLElement });
        out += `{m${index}o}` + _encodeNodes(Array.from(element.childNodes), slots) + `{m${index}c}`;
    }
    return out;
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
export function reconstitute(resolved: string, slots: RichSlot[], doc: Document = document): Node[] {
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
