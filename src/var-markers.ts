import { normalizeMarkupPlaceholders, normalizeTokenText, type RichTextNode } from './identity.js';
import { interpolate, isICU } from './interpolate.js';
import type { ParamPrimitive } from './types/translation-fn.js';

/**
 * Value markers (spec VAR-3): how an emitter tells a reader which printed text
 * was a variable, and what it was called, so the reader registers a placeholder
 * instead of one phrase per value (VAR-1).
 *
 *   <p>Hello <!--ls:name-->Ana<!--/ls-->, welcome back</p>
 *   <p>Hello <span data-ls-param="name">Ana</span>, welcome back</p>
 *   [{ text: 'Hello ' }, { comment: 'ls:name' }, { text: 'Ana' }, { comment: '/ls' }, { text: ', welcome back' }]
 *
 * all read as the one token `Hello {name}, welcome back`, with param `name` =
 * `Ana`. The value is text only: an element inside the pair voids the marker,
 * and its comments then split text as any comment does.
 *
 * Within one parent, the text on both sides of a marker, and every marker in
 * between, merge into one run. Everything without a marker splits exactly as
 * before, so no id derived from unmarked markup changes.
 */

/** The attribute form's attribute, for an emitter that cannot write comments. */
export const VAR_PARAM_ATTR = 'data-ls-param';

/** A placeholder name (VAR-2's grammar). */
const NAME = /^[a-z][a-z0-9_]*$/;
const OPEN = /^ls:([a-z][a-z0-9_]*)$/;
const CLOSE = '/ls';

const ELEMENT = 1;
const TEXT = 3;
const COMMENT = 8;

/** What the grouping reads from a node: the DOM's shape, or a tree view's. */
export interface MarkerNode {
    nodeType: number;
    nodeValue: string | null;
    childNodes: ArrayLike<MarkerNode>;
    getAttribute?(name: string): string | null;
}

/** A marked value: its name, the text nodes holding the value, and the nodes that mark it. */
export interface VarMarker<N> {
    name: string;
    value: N[];
    /** The nodes that are the marker itself: a comment pair, or the `data-ls-param` element. */
    frame: N[];
}

export type RunPart<N> = { text: N } | { marker: VarMarker<N> };

/** One merged run: text nodes and markers, in order, holding at least one marker. */
export interface VarRun<N> {
    parts: RunPart<N>[];
}

export type RunItem<N> = { node: N } | { run: VarRun<N> };

/** The name an element marks as a value (`data-ls-param`, holding text only), or null when it is no marker. */
export function paramElementName(node: MarkerNode): string | null {
    if (node.nodeType !== ELEMENT || !node.getAttribute) return null;
    const name = node.getAttribute(VAR_PARAM_ATTR)?.trim();
    if (!name || !NAME.test(name)) return null;
    return Array.from(node.childNodes).every((child) => child.nodeType === TEXT) ? name : null;
}

/** The marker starting at `children[i]`, and the index after it; null when there is none there. */
function markerAt<N extends MarkerNode>(children: readonly N[], i: number): { marker: VarMarker<N>; next: number } | null {
    const node = children[i]!;
    if (node.nodeType === COMMENT) {
        const open = OPEN.exec((node.nodeValue ?? '').trim());
        if (!open) return null;
        const value: N[] = [];
        let j = i + 1;
        while (j < children.length && children[j]!.nodeType === TEXT) value.push(children[j++]!);
        const close = children[j];
        // Anything but text before the close voids the pair (an element inside, or no close).
        if (!close || close.nodeType !== COMMENT || (close.nodeValue ?? '').trim() !== CLOSE) return null;
        return { marker: { name: open[1]!, value, frame: [node, close] }, next: j + 1 };
    }
    const name = paramElementName(node);
    if (name !== null) return { marker: { name, value: Array.from(node.childNodes) as N[], frame: [node] }, next: i + 1 };
    return null;
}

/**
 * A parent's children as items: each run of text and markers that holds a
 * marker, and every other node as itself. Adjacent text with no marker among it
 * stays separate nodes, as the walks have always seen it.
 */
export function groupRuns<N extends MarkerNode>(children: ArrayLike<N>): RunItem<N>[] {
    const list = Array.from(children);
    const items: RunItem<N>[] = [];
    let parts: RunPart<N>[] = [];
    const flush = () => {
        if (parts.some((part) => 'marker' in part)) items.push({ run: { parts } });
        else for (const part of parts) items.push({ node: (part as { text: N }).text });
        parts = [];
    };
    for (let i = 0; i < list.length; i++) {
        const node = list[i]!;
        if (node.nodeType === TEXT) {
            parts.push({ text: node });
            continue;
        }
        const found = markerAt(list, i);
        if (found) {
            parts.push({ marker: found.marker });
            i = found.next - 1;
            continue;
        }
        flush();
        items.push({ node });
    }
    flush();
    return items;
}

/** A run's text, with `{NAME}` for each marker; `text` reads a text node (its original, where one is kept). */
export function runSource<N extends MarkerNode>(run: VarRun<N>, text: (node: N) => string = (n) => n.nodeValue ?? ''): string {
    return run.parts.map((part) => ('text' in part ? text(part.text) : `{${part.marker.name}}`)).join('');
}

/** A run's token, normalised as a text node's token is. Empty when the run holds only whitespace and markers. */
export function runToken<N extends MarkerNode>(run: VarRun<N>, text?: (node: N) => string): string {
    return normalizeMarkupPlaceholders(normalizeTokenText(runSource(run, text)));
}

/** Whether a run has no text of its own: only markers, and whitespace. */
export function isMarkerOnly<N extends MarkerNode>(run: VarRun<N>, text: (node: N) => string = (n) => n.nodeValue ?? ''): boolean {
    return run.parts.every((part) => 'marker' in part || !normalizeTokenText(text(part.text)));
}

/** The value each marker carries, by name: the text it holds now. */
export function runValues<N extends MarkerNode>(run: VarRun<N>, value: (node: N) => string = (n) => n.nodeValue ?? ''): Record<string, string> {
    const values: Record<string, string> = {};
    for (const part of run.parts) {
        if ('marker' in part && !(part.marker.name in values)) {
            values[part.marker.name] = normalizeTokenText(part.marker.value.map(value).join(''));
        }
    }
    return values;
}

/**
 * The text each node of a run shows for `template` (the run's translation, or its
 * source): what to write into each text node, and into each marked value's nodes.
 *
 * In place when the template keeps every marker's placeholder exactly once, in
 * the markers' order, and is not ICU: the text between the markers goes into the
 * text nodes between them, and the value nodes keep the value, so a framework's
 * later update to them stays live. Otherwise the whole sentence, with the values
 * interpolated, goes into the run's first text node, and every other text node
 * and value node is emptied; a later value update then needs a re-render.
 *
 * `params` are the caller's; a marker's value is its param only when the caller
 * does not name that param itself. A param the caller names is written into the
 * value's nodes, in place as in a whole sentence.
 */
export function renderRun<N extends MarkerNode>(
    run: VarRun<N>,
    template: string,
    params: Record<string, ParamPrimitive>,
    locale: string,
    source: { text: (node: N) => string; value: (marker: VarMarker<N>) => string }
): Array<[N, string]> {
    const groups: N[][] = [[]];
    const markers: VarMarker<N>[] = [];
    for (const part of run.parts) {
        if ('text' in part) groups[groups.length - 1]!.push(part.text);
        else {
            markers.push(part.marker);
            groups.push([]);
        }
    }
    const texts = groups.flat();
    const leadOf = (node: N | undefined) => (node ? /^\s*/.exec(source.text(node))![0] : '');
    const trailOf = (node: N | undefined) => (node ? /\s*$/.exec(source.text(node))![0] : '');
    const lastGroup = groups[groups.length - 1]!;
    // The run's own outer whitespace stays where it was, as a text node's does.
    const edge = (i: number, segment: string) =>
        (i === 0 ? leadOf(groups[0]![0]) : '') + segment + (i === groups.length - 1 ? trailOf(lastGroup[lastGroup.length - 1]) : '');

    const segments = splitAtMarkers(template, markers.map((m) => m.name));
    const inPlace = segments !== null && segments.every((segment, i) => groups[i]!.length > 0 || segment === '');
    const writes: Array<[N, string]> = [];
    if (inPlace) {
        segments!.forEach((segment, i) => {
            groups[i]!.forEach((node, k) => writes.push([node, k === 0 ? edge(i, interpolate(segment, params, locale)) : '']));
        });
        for (const marker of markers) {
            const node = marker.value[0];
            if (!node) continue;
            if (marker.name in params) {
                // The caller names the param itself, so it is the value shown (VAR-3).
                const text = interpolate(`{${marker.name}}`, params, locale);
                marker.value.forEach((n, k) => writes.push([n, k === 0 ? text : '']));
            } else if (!marker.value.map((n) => n.nodeValue ?? '').join('')) {
                // A value an earlier whole-sentence render emptied is shown again.
                writes.push([node, source.value(marker)]);
            }
        }
        return writes;
    }
    const values: Record<string, ParamPrimitive> = {};
    for (const marker of markers) if (!(marker.name in values)) values[marker.name] = source.value(marker);
    const whole = interpolate(template, { ...values, ...params }, locale);
    const first = texts[0];
    if (!first) return writes;
    const text = leadOf(first) + whole + trailOf(texts[texts.length - 1]);
    for (const node of texts) writes.push([node, node === first ? text : '']);
    for (const marker of markers) for (const node of marker.value) writes.push([node, '']);
    return writes;
}

/** The template's text between the markers' placeholders, or null unless each appears once, in order, outside ICU. */
function splitAtMarkers(template: string, names: string[]): string[] | null {
    if (isICU(template) || new Set(names).size !== names.length) return null;
    const segments: string[] = [];
    let rest = template;
    for (const name of names) {
        const token = `{${name}}`;
        const at = rest.indexOf(token);
        if (at < 0 || rest.indexOf(token, at + token.length) >= 0) return null;
        segments.push(rest.slice(0, at));
        rest = rest.slice(at + token.length);
    }
    segments.push(rest);
    // A placeholder of a marker must not also appear in an earlier segment.
    if (segments.some((segment) => names.some((name) => segment.includes(`{${name}}`)))) return null;
    return segments;
}

/**
 * A rich phrase's nodes (`encodeRichPhrase`), reading value markers: each marked
 * value is its `{NAME}` placeholder, its value goes into `values`, and a comment
 * that marks nothing is dropped. Every other element is a markup slot, as before.
 */
export function toRichNodes<N extends MarkerNode, T>(
    children: ArrayLike<N>,
    payload: (element: N) => T,
    values: Record<string, string> = {}
): RichTextNode<T>[] {
    const out: RichTextNode<T>[] = [];
    for (const item of groupRuns(children)) {
        if ('run' in item) {
            for (const part of item.run.parts) {
                if ('text' in part) out.push({ text: part.text.nodeValue ?? '' });
                else {
                    out.push({ param: part.marker.name });
                    if (!(part.marker.name in values)) {
                        values[part.marker.name] = normalizeTokenText(part.marker.value.map((node) => node.nodeValue ?? '').join(''));
                    }
                }
            }
            continue;
        }
        const node = item.node;
        if (node.nodeType === TEXT) out.push({ text: node.nodeValue ?? '' });
        else if (node.nodeType === ELEMENT) out.push({ children: toRichNodes(node.childNodes as ArrayLike<N>, payload, values), payload: payload(node) });
    }
    return out;
}
