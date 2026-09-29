import {
    CONTENT_BLOCK_MARKER_ATTR,
    RESOLVED_MARKER_ATTR,
    findSingleTextNode,
    isContentBlockKnown,
    isExcisedFromUnit,
    isPhraseMarked,
    readContentBlockMarker,
    hostCategory,
    RESOLVED_MARKER_ATTRS,
    isInResolvedScope,
    registerContentBlock,
    resolveHistoricalBlockId,
    tokenizeNodes,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
    type WalkNode,
} from './content-block.js';
import { encodeRichPhrase, generateCustomId, historicalCustomIds, normalizeMarkupPlaceholders, normalizeTokenText, type RichTextNode } from './identity.js';
import { interpolate, isICU } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { markupTokenValues, splitSentinels, stripSentinels } from './richtext.js';
import { activeCatalog, activeScope } from './scope-context.js';
import { isBlockHandled, isServerCollected, markBlockHandled, rememberSeededBlock } from './served-source.js';
import { logger } from './logger.js';
import { config as configStore, currentlyLoadedLocale } from './stores.js';
import type { CatalogView } from './translations.js';
import type { ParamPrimitive } from './types/translation-fn.js';
import type { iCategories } from './types/translations.js';

/**
 * Content blocks without a DOM (spec SRV-1, MARK-1, TOK-6): identify, translate
 * and register a `<Translate>` block from a tree, so a framework rendering on a
 * server, or rendering on the client before mount, emits the translated block
 * and its stamped id instead of source text.
 *
 * A tree is the block's content, the children of the host element, as plain
 * nodes. It is walked by the same code as the DOM (`tokenizeNodes`,
 * `findSingleTextNode`, `isExcisedFromUnit`) through a DOM-shaped view of it, so
 * a tree and the DOM it mirrors yield the same tokens, shape and id.
 *
 * `renderBlock` is synchronous and pure over the active catalog: it registers
 * nothing and its output is the same on a server and in the browser for the
 * same catalog, so a client's first render matches what the server sent. A
 * binding registers with `registerBlock`, which touches no DOM.
 */

/** A node of a block's content. Attribute values are strings; `true` is an attribute with no value. */
export type BlockNode =
    | { text: string }
    | { comment: string }
    | { tag: string; attrs?: Readonly<Record<string, string | true>>; children?: readonly BlockNode[] };

/**
 * A node of a rendered block. Every element names, as `source`, the pre-order
 * index of the input element it renders (elements only, counted across the
 * whole input from 0), so a binding can re-attach what the tree cannot carry —
 * handlers, refs, keys — even where a translation reorders inline markup.
 */
export type RenderedNode =
    | { text: string }
    | { comment: string }
    | { tag: string; attrs: Record<string, string | true>; children: RenderedNode[]; source: number };

export type BlockShape = 'phrase' | 'block' | 'empty';

export interface BlockOptions {
    category?: string;
    params?: Record<string, ParamPrimitive>;
    /** A label for the block in the Translation Manager, as `Translate`'s option. */
    label?: string;
    /**
     * The app's own `custom_id` for the block: rendered under it, and registered
     * under it with its content when the catalog does not hold it, as
     * `Translate`'s `custom_id` option does.
     */
    id?: string;
    /**
     * A `custom_id` to ADOPT: a renderer already rendered this block from the
     * catalog under it (a stamp carried with the resolved marker, MARK-3). Rendered
     * under it, never registered.
     */
    customId?: string;
    /**
     * `registerBlock` only: the host element on the client, whose ancestors decide
     * GATE-10. The walk starts at its parent, since the host itself carries the
     * resolved marker when it was rendered from the catalog.
     */
    host?: Element;
}

export interface RenderedBlock {
    shape: BlockShape;
    /** The id the block renders under: derived, a historical id the catalog holds (CID-3), or adopted. Null when empty. */
    customId: string | null;
    nodes: RenderedNode[];
    /**
     * The attributes to set on the host: the block's id (MARK-1), and, when the
     * rendered text is a translation (a locale other than the base), the resolved
     * marker with that locale (GATE-10), so a DOM reader on the client never files
     * the served translation as source. Empty for an empty block.
     */
    hostAttrs: Record<string, string>;
}

/**
 * A block as a request scope's seed carries it (SRV-4), for a client that cannot
 * recover the block's source from its DOM: `registerBlock` accepts it in place
 * of the source nodes.
 */
export interface SeededBlock {
    customId: string;
    category: string;
    tokens: string[];
    shape: 'phrase' | 'block';
    /**
     * The server's scope sends this block itself at `close()` (the `server`
     * strategy, or `auto` for a short list), so a client never registers it:
     * not from the seed, and not from the `Translate` over its host.
     */
    collected?: boolean;
}

/**
 * A phrase a request scope's render missed, as its seed carries it: `t()`, a
 * `<Phrase>` host or a single-token block. `collected` as on `SeededBlock`: the
 * scope sends it itself at `close()`, and the client never records it again.
 */
export interface SeededPhrase {
    category: string;
    phrase: string;
    collected?: boolean;
}

/** A request scope's hydration seed (SRV-4): `LangsysApp.seedCatalog(seed.catalog, seed.locale, seed)` on the client. */
export interface RequestSeed {
    locale: string;
    catalog: iCategories;
    blocks: Record<string, SeededBlock>;
    phrases: SeededPhrase[];
}

/** The tokens and shape of a block's content, exactly as `tokenizeElement` and `Translate` decide them for the same markup. */
export function tokenizeTree(nodes: readonly BlockNode[]): { tokens: string[]; shape: BlockShape } {
    const root = view(nodes);
    const tokens = tokenizeNodes(root);
    return { tokens, shape: shapeOf(root, tokens, false) };
}

/**
 * Render a block from its content: the translated tree, the id it renders
 * under and the marker to stamp. Synchronous, registers nothing, and reads only
 * the active catalog (a request scope's, or the page's), so the same input and
 * catalog render the same bytes on a server and in the browser.
 *
 * Nested marked hosts are units of their own (MARK-4), rendered in place: a
 * phrase host as its rich phrase, a declared block as its own block (stamped
 * with its id), a stamped one under its id. `translate="no"`, `data-notrans`
 * and code elements are returned as given.
 */
export function renderBlock(nodes: readonly BlockNode[], options: BlockOptions = {}): RenderedBlock {
    const root = view(nodes);
    const tokens = tokenizeNodes(root);
    const rendered = renderView(root, options);
    // A request scope keeps what it rendered, for its seed (SRV-4).
    if (rendered.customId && rendered.shape !== 'empty') {
        activeScope()?.recordRendered({ customId: rendered.customId, category: options.category ?? '', tokens, shape: rendered.shape });
    }
    return rendered;
}

/** The notices already given, one per reason. */
const warnedUnrendered = new Set<string>();

/**
 * Report, as a debug notice once per process per reason (SRV-1), that a block
 * was served as source because the binding could not show it to the renderer:
 * a framework component in its subtree, a raw-HTML prop, a raw-text element, a
 * suspense placeholder. That is SRV-1's one sanctioned fallback, not a fault:
 * the block is served with no resolved marker and its app-supplied id stamped
 * where it has one, and the client renders and registers it after hydration.
 * The notice is the core's (bindings write no console output of their own), and
 * a reason reported while debug is off is reported when it next occurs with it on.
 */
export function warnUnrenderedBlock(reason: string): void {
    if (!logger.debugEnabled || warnedUnrendered.has(reason)) return;
    warnedUnrendered.add(reason);
    logger.log(
        `A <Translate> block was served as source (${reason}): the binding could not show it to the renderer, so the client renders and registers it after hydration.`
    );
}

/**
 * Register a block for discovery, with no DOM: what `Translate` registers when
 * it mounts, for a framework that owns the host's text nodes and renders
 * through `renderBlock`. A single-token unit records its phrase miss as `t()`
 * does; a block the catalog lacks, under no historical id, registers with its
 * content; an adopted id (`customId`) registers nothing; nested phrase hosts and
 * declared or unresolved-stamped blocks register as their own units. Inside a
 * request scope it is held for `close()`. Fire-and-forget; never throws.
 *
 * One-shot: it records what the block is now. A binding calls it again on each
 * change `t` goes through — a locale switch, a new catalog, a navigation — as
 * `Translate` re-enters its lookup (HINT-13).
 *
 * The flows it serves: on a server the outermost host renders and registers,
 * and nested declared hosts are covered through its tree. On the client after
 * hydration, the blocks a scope rendered are registered from its seed, one
 * `registerBlock(seededBlock)` per `seed().blocks` entry after `init()`, since
 * the DOM already holds translated text. That loop is for bindings that mount
 * the DOM classes; a binding that renders trees registers each block from its
 * nodes as it renders. Either way a block or phrase the seed marks `collected`
 * is never registered: the server's scope sends it itself.
 */
export function registerBlock(input: readonly BlockNode[] | SeededBlock, options: BlockOptions = {}): void {
    if (!Array.isArray(input)) rememberSeededBlock(input as SeededBlock);
    // GATE-10: text inside a resolved scope is never recorded. The walk starts at the
    // host's PARENT. A host carries data-ls-resolved itself only when it was rendered
    // from the catalog (`hostAttrs`), and then its block is known and registering it is
    // a no-op; counting the host would instead let that client-side stamp silence the
    // re-entry registration HINT-13 asks for on every later `t` change.
    if (options.host && isInResolvedScope(options.host.parentElement)) return;
    const root = Array.isArray(input) ? view(input) : null;
    const register = () => {
        try {
            if (root) registerView(root, options, input as readonly BlockNode[]);
            else registerSeeded(input as SeededBlock);
        } catch {
            // Registration never takes a render down with it (REG-10).
        }
    };
    // Inside a scope the scope's catalog is in hand. On a page, what is known is decided
    // once the first catalog has settled, as `Translate` decides it: before then every
    // block and phrase looks unknown, and one the catalog holds would be sent.
    if (activeScope()) register();
    else void LangsysApp.Translations.ready().then(register);
}

/**
 * A host element's content as a tree: its child nodes as `BlockNode`s, a
 * `<template>`'s content included. For a binding that holds a DOM, on a server
 * or on the client, so no binding walks a DOM of its own to tokenize.
 */
export function blockNodesOf(element: { childNodes: ArrayLike<Node> }): BlockNode[] {
    const out: BlockNode[] = [];
    for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === 3) out.push({ text: node.nodeValue ?? '' });
        else if (node.nodeType === 8) out.push({ comment: node.nodeValue ?? '' });
        else if (node.nodeType === 1) {
            const el = node as Element;
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
            const content = el.localName === 'template' ? (el as HTMLTemplateElement).content : el;
            out.push({ tag: el.localName, attrs, children: blockNodesOf(content) });
        }
    }
    return out;
}

/**
 * Write a rendered block into the host's EXISTING nodes: each text node's value,
 * each translatable attribute and each nested host's unit markers (its id and
 * resolved marker, MARK-1, GATE-10), in place, never replacing a node, so a
 * framework's references to them stay live; and, given a whole `RenderedBlock`,
 * its `hostAttrs` on the host. Only when the DOM has the rendered tree's
 * structure: the same nodes in the same places, each element where its `source`
 * says. Otherwise nothing is touched and it returns
 * `{ applied: false, reason: 'structure' }`: a translation that reorders inline
 * markup cannot be applied to nodes a framework owns.
 *
 * With `self`, `element` is the tree's root rather than its parent: the tree was
 * rendered from `[{ tag, attrs, children: blockNodesOf(element) }]`, as a
 * standalone phrase host is (`data-ls-phrase` on the root, at `source` 0), and
 * `element` is matched against its one root node.
 */
export function applyRendered(
    element: Element,
    rendered: RenderedBlock | readonly RenderedNode[],
    options: { self?: boolean } = {}
): { applied: boolean; reason?: 'structure' } {
    const nodes = Array.isArray(rendered) ? (rendered as readonly RenderedNode[]) : (rendered as RenderedBlock).nodes;
    const writes: Array<() => void> = [];
    let preorder = 0;
    const walk = (parent: { childNodes: ArrayLike<Node> }, list: readonly RenderedNode[]): boolean => {
        const children = Array.from(parent.childNodes).filter((n) => n.nodeType === 1 || n.nodeType === 3 || n.nodeType === 8);
        if (children.length !== list.length) return false;
        for (let i = 0; i < list.length; i++) {
            const dom = children[i]!;
            const node = list[i]!;
            if ('text' in node) {
                if (dom.nodeType !== 3) return false;
                if (dom.nodeValue !== node.text) writes.push(() => (dom.nodeValue = node.text));
            } else if ('comment' in node) {
                if (dom.nodeType !== 8) return false;
            } else {
                const el = dom as Element;
                if (dom.nodeType !== 1 || el.localName !== node.tag || node.source !== preorder++) return false;
                for (const [name, value] of Object.entries(node.attrs)) {
                    const text = value === true ? '' : value;
                    const written = isTranslatableAttribute(el.localName, name, node.attrs) || UNIT_MARKER_ATTRS.includes(name);
                    if (written && el.getAttribute(name) !== text) {
                        writes.push(() => el.setAttribute(name, text));
                    }
                }
                const content = el.localName === 'template' ? (el as HTMLTemplateElement).content : el;
                if (!walk(content, node.children)) return false;
            }
        }
        return true;
    };
    const parent = options.self ? { childNodes: [element] as unknown as ArrayLike<Node> } : element;
    if (!walk(parent, nodes)) return { applied: false, reason: 'structure' };
    for (const write of writes) write();
    if (!Array.isArray(rendered)) {
        for (const [name, value] of Object.entries((rendered as RenderedBlock).hostAttrs)) element.setAttribute(name, value);
    }
    return { applied: true };
}

/** The markers a render sets on a nested host, and `applyRendered` writes. */
const UNIT_MARKER_ATTRS: readonly string[] = [CONTENT_BLOCK_MARKER_ATTR, RESOLVED_MARKER_ATTR];

function isTranslatableAttribute(tag: string, name: string, attrs: Record<string, string | true>): boolean {
    if ((TRANSLATABLE_ATTRIBUTES as readonly string[]).includes(name)) return true;
    if (name !== 'value') return false;
    if (VALUE_TRANSLATABLE_ELEMENTS.includes(tag)) return true;
    const type = attrs.type;
    return tag === 'input' && typeof type === 'string' && VALUE_TRANSLATABLE_INPUT_TYPES.includes(type.toLowerCase());
}

/** Serialise a block's content as HTML, for the content snapshot a block registers with. Not identity. */
export function serializeTree(nodes: readonly BlockNode[]): string {
    return nodes.map(serializeNode).join('');
}

// ---------------------------------------------------------------------
// A DOM-shaped view of a tree, so the DOM's walks run over it unchanged.
// ---------------------------------------------------------------------

class ViewText implements WalkNode {
    readonly nodeType = 3;
    readonly childNodes: ViewNode[] = [];
    constructor(public nodeValue: string) {}
    hasChildNodes(): boolean {
        return false;
    }
    get textContent(): string {
        return this.nodeValue;
    }
}

class ViewComment implements WalkNode {
    readonly nodeType = 8;
    readonly childNodes: ViewNode[] = [];
    constructor(public nodeValue: string) {}
    hasChildNodes(): boolean {
        return false;
    }
    get textContent(): string {
        return '';
    }
}

class ViewElement implements WalkNode {
    readonly nodeType = 1;
    readonly nodeValue = null;
    readonly tagName: string;
    readonly attrs: Map<string, string | true>;
    childNodes: ViewNode[];

    constructor(
        tag: string,
        attrs: Readonly<Record<string, string | true>> | undefined,
        children: ViewNode[],
        readonly source: number
    ) {
        this.tagName = tag.toUpperCase();
        this.attrs = new Map(Object.entries(attrs ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
        this.childNodes = children;
    }

    getAttribute(name: string): string | null {
        const value = this.attrs.get(name.toLowerCase());
        return value === undefined ? null : value === true ? '' : value;
    }
    hasAttribute(name: string): boolean {
        return this.attrs.has(name.toLowerCase());
    }
    setAttribute(name: string, value: string): void {
        this.attrs.set(name.toLowerCase(), String(value));
    }
    hasChildNodes(): boolean {
        return this.childNodes.length > 0;
    }
    get textContent(): string {
        return this.childNodes.map((c) => c.textContent).join('');
    }
    /** Only what the legacy select-option walk asks: `option` descendants. */
    querySelectorAll(selector: string): ViewElement[] {
        const out: ViewElement[] = [];
        const visit = (el: ViewElement) => {
            for (const child of el.childNodes) {
                if (!(child instanceof ViewElement)) continue;
                if (child.tagName.toLowerCase() === selector.toLowerCase()) out.push(child);
                visit(child);
            }
        };
        visit(this);
        return out;
    }
}

type ViewNode = ViewText | ViewComment | ViewElement;

function view(nodes: readonly BlockNode[]): ViewNode[] {
    let next = 0;
    const build = (list: readonly BlockNode[]): ViewNode[] =>
        list.map((node) => {
            if ('text' in node) return new ViewText(node.text);
            if ('comment' in node) return new ViewComment(node.comment);
            const source = next++;
            return new ViewElement(node.tag, node.attrs, build(node.children ?? []), source);
        });
    return build(nodes);
}

function toRendered(nodes: readonly ViewNode[]): RenderedNode[] {
    return nodes.map((node) => {
        if (node instanceof ViewText) return { text: node.nodeValue };
        if (node instanceof ViewComment) return { comment: node.nodeValue };
        return {
            tag: node.tagName.toLowerCase(),
            attrs: Object.fromEntries(node.attrs),
            children: toRendered(node.childNodes),
            source: node.source,
        };
    });
}

function toBlockNodes(nodes: readonly ViewNode[]): BlockNode[] {
    return toRendered(nodes).map(function strip(node): BlockNode {
        if ('text' in node || 'comment' in node) return node;
        return { tag: node.tag, attrs: node.attrs, children: node.children.map(strip) };
    });
}

// ---------------------------------------------------------------------
// Render and register, mirroring `Translate`.
// ---------------------------------------------------------------------

function shapeOf(root: ViewNode[], tokens: string[], adopted: boolean): BlockShape {
    if (tokens.length === 0) return 'empty';
    // TOK-6, and an adopted id is a block's (MARK-1 stamps blocks).
    if (!adopted && tokens.length === 1 && findSingleTextNode({ childNodes: root }) !== null) return 'phrase';
    return 'block';
}

/** `t()`'s lookup without its miss: what `renderBlock` reads, so rendering records nothing. */
const readOnlyView = (): CatalogView => ({
    catalog: () => activeCatalog(),
    locale: () => currentlyLoadedLocale.get(),
    miss: () => {},
    fromSnapshot: () => false,
});

/** The id a block renders under: adopted, derived, or a historical id the catalog verifies (CID-3, CID-4). */
function resolveId(root: ViewNode[], tokens: string[], category: string, adopted: string | undefined): string {
    if (adopted) return adopted;
    const derived = generateCustomId(category, tokens);
    if (isContentBlockKnown(category, derived)) return derived;
    const candidates = historicalCustomIds(category, tokens, tokenizeNodes(root, true)).filter((id) => id !== derived);
    return resolveHistoricalBlockId(category, candidates, tokens) ?? derived;
}

function renderView(root: ViewNode[], options: BlockOptions): RenderedBlock {
    const { category = '', params = {} } = options;
    const tokens = tokenizeNodes(root);
    const shape = shapeOf(root, tokens, !!options.customId);
    const locale = currentlyLoadedLocale.get();
    const apply = (text: string) => interpolate(text, params, locale);

    renderNestedHosts(root, options);

    if (shape === 'empty') return { shape, customId: null, nodes: toRendered(root), hostAttrs: {} };
    // Resolved only when the text served is a translation from the catalog: a block
    // the catalog lacks is served as source, and a client honouring GATE-10 must
    // still discover it.
    const hostAttrs = (id: string, fromCatalog: boolean): Record<string, string> =>
        fromCatalog && locale && locale !== configStore.baseLocale
            ? { [CONTENT_BLOCK_MARKER_ATTR]: id, [RESOLVED_MARKER_ATTR]: locale }
            : { [CONTENT_BLOCK_MARKER_ATTR]: id };

    if (shape === 'phrase') {
        // As `Translate.renderSingleToken`: the block entry first, then `t()`'s lookup.
        const id = options.id ?? generateCustomId(category, tokens);
        const node = findSingleTextNode({ childNodes: root }) as ViewText;
        const token = tokens[0]!;
        const fromBlock = LangsysApp.Translations.lookupContent(category, id, token);
        const inBlock = fromBlock !== null && fromBlock !== undefined;
        node.nodeValue = inBlock ? apply(fromBlock) : LangsysApp.Translations.renderWith(readOnlyView(), token, [category, params]);
        const fromCatalog = inBlock || LangsysApp.Translations.lookup(token, category) !== null;
        return { shape, customId: id, nodes: toRendered(root), hostAttrs: hostAttrs(id, fromCatalog) };
    }

    const id = options.customId ?? options.id ?? resolveId(root, tokens, category, undefined);
    // As `Translate.translate`: at the base locale, with no params and no ICU, the
    // content is left exactly as written.
    const untouched = locale === configStore.baseLocale && Object.keys(params).length === 0 && !tokens.some((t) => isICU(t));
    if (!untouched) translateNodes(root, (token) => LangsysApp.Translations.lookupContent(category, id, token), apply);
    return { shape, customId: id, nodes: toRendered(root), hostAttrs: hostAttrs(id, isContentBlockKnown(category, id)) };
}

/** `Translate.translate` over a view: this unit's text nodes and attributes, never what it excises. */
function translateNodes(nodes: ViewNode[], lookup: (token: string) => string | null, apply: (text: string) => string): void {
    for (const node of nodes) {
        if (node instanceof ViewComment) continue;
        if (node instanceof ViewElement) {
            if (isExcisedFromUnit(node as unknown as Element)) continue;
            translateAttributes(node, lookup, apply);
            translateNodes(node.childNodes, lookup, apply);
            continue;
        }
        if (!normalizeTokenText(node.nodeValue)) continue;
        const original = normalizeMarkupPlaceholders(node.nodeValue);
        const token = normalizeTokenText(original);
        if (!token) continue;
        const translation = lookup(token);
        node.nodeValue = translation ? original.replace(token, () => apply(translation)) : apply(original);
    }
}

function translateAttributes(element: ViewElement, lookup: (token: string) => string | null, apply: (text: string) => string): void {
    const tag = element.tagName.toLowerCase();
    const names: string[] = [...TRANSLATABLE_ATTRIBUTES];
    if (VALUE_TRANSLATABLE_ELEMENTS.includes(tag)) names.push('value');
    const inputType = element.getAttribute('type')?.toLowerCase();
    if (tag === 'input' && inputType && VALUE_TRANSLATABLE_INPUT_TYPES.includes(inputType)) names.push('value');
    for (const name of names) {
        const raw = element.getAttribute(name);
        if (raw === null) continue;
        const original = normalizeMarkupPlaceholders(raw);
        const token = normalizeTokenText(original);
        if (!token) continue;
        const translation = lookup(token);
        element.setAttribute(name, apply(translation ?? original));
    }
}

/**
 * Nested marked hosts, rendered in place (MARK-2, MARK-3, MARK-4). A host's own
 * inside is its own unit's; excluded subtrees and code are left as given.
 */
/**
 * The options a nested host is its own unit under: its own category when it names
 * one (`data-ls-category`), else the enclosing block's; and, for a stamped id,
 * adoption when the stamp carries the resolved marker, the id to register under
 * when it does not (MARK-3).
 */
function nestedOptions(node: ViewElement, outer: BlockOptions, resolved: boolean): BlockOptions {
    const element = node as unknown as Element;
    const options: BlockOptions = { category: hostCategory(element) ?? outer.category, params: outer.params, label: outer.label };
    const marker = readContentBlockMarker(element);
    if (marker?.kind === 'identity') {
        if (resolvedHere(element, resolved)) options.customId = marker.id;
        else options.id = marker.id;
    }
    return options;
}

/**
 * Whether an element sits in a resolved scope within the tree (GATE-10, MARK-3):
 * its own resolved marker decides, else its nearest marked ancestor's, which the
 * walk carries down as `inherited`.
 */
function resolvedHere(element: Element, inherited: boolean): boolean {
    for (const attr of RESOLVED_MARKER_ATTRS) {
        if (!element.hasAttribute(attr)) continue;
        const value = (element.getAttribute(attr) ?? '').trim().toLowerCase();
        return value !== 'false' && value !== '0';
    }
    return inherited;
}

function renderNestedHosts(nodes: ViewNode[], options: BlockOptions, resolved = false): void {
    for (const node of nodes) {
        if (!(node instanceof ViewElement)) continue;
        if (isPhraseMarked(node as unknown as Element)) {
            node.childNodes = renderPhraseHost(node, nestedOptions(node, options, resolved));
            continue;
        }
        const marker = readContentBlockMarker(node as unknown as Element);
        if (marker) {
            // Rendered in place: the nested render works on these same view nodes, so
            // every element keeps its `source` in the enclosing input's numbering.
            const nested = nestedOptions(node, options, resolved);
            const tokens = tokenizeNodes(node.childNodes);
            const rendered = renderView(node.childNodes, nested);
            // The nested host is stamped as the outer host is (MARK-1, GATE-10), and a
            // scope keeps it for its seed, so the client recovers its source too.
            // A stamped host keeps the id it carries, in the spelling it carries it.
            for (const [name, value] of Object.entries(rendered.hostAttrs)) {
                if (marker.kind === 'identity' && name === CONTENT_BLOCK_MARKER_ATTR) continue;
                node.setAttribute(name, value);
            }
            if (rendered.customId && rendered.shape !== 'empty') {
                activeScope()?.recordRendered({ customId: rendered.customId, category: nested.category ?? '', tokens, shape: rendered.shape });
            }
            continue;
        }
        if (isExcisedFromUnit(node as unknown as Element)) continue;
        renderNestedHosts(node.childNodes, options, resolvedHere(node as unknown as Element, resolved));
    }
}

/** A phrase host's children, rendered as `Phrase._render` renders them, from a view. */
function renderPhraseHost(host: ViewElement, options: BlockOptions): ViewNode[] {
    const { category = '', params = {} } = options;
    const toRich = (nodes: ViewNode[]): RichTextNode<ViewElement>[] =>
        nodes.flatMap((node): RichTextNode<ViewElement>[] => {
            if (node instanceof ViewText) return [{ text: node.nodeValue }];
            if (node instanceof ViewComment) return [];
            return [{ children: toRich(node.childNodes), payload: node }];
        });
    const { phrase, slots } = encodeRichPhrase(toRich(host.childNodes));
    if (!phrase) return host.childNodes;
    const translated = LangsysApp.Translations.lookup(phrase, category);
    const locale = currentlyLoadedLocale.get();
    // A translation from the catalog is marked resolved, as a block's host is, so a
    // client never reads it as the source phrase (GATE-10).
    if (translated !== null && locale && locale !== configStore.baseLocale) host.setAttribute(RESOLVED_MARKER_ATTR, locale);
    const raw = translated ?? phrase;
    const resolved = interpolate(raw, { ...params, ...markupTokenValues(slots.length) }, locale);
    const parts = splitSentinels(resolved);
    if (!parts) return [new ViewText(stripSentinels(resolved))];

    const top: ViewNode[] = [];
    const stack: ViewNode[][] = [top];
    for (const part of parts) {
        const current = stack[stack.length - 1]!;
        if ('text' in part) current.push(new ViewText(part.text));
        else if ('open' in part) {
            const slot = slots[part.open];
            if (!slot) return [new ViewText(stripSentinels(resolved))];
            const clone = new ViewElement(slot.tagName, Object.fromEntries(slot.attrs), [], slot.source);
            current.push(clone);
            stack.push(clone.childNodes);
        } else stack.pop();
    }
    return top;
}

function registerView(root: ViewNode[], options: BlockOptions, input: readonly BlockNode[]): void {
    const { category = '', label } = options;
    const tokens = tokenizeNodes(root);
    const shape = shapeOf(root, tokens, !!options.customId);

    registerNestedHosts(root, options);

    if (shape === 'empty' || options.customId) return;
    if (shape === 'phrase') {
        const id = options.id ?? generateCustomId(category, tokens);
        // The server's request scope sends it itself (its seed says so, SSR-1/SSR-2).
        if (isServerCollected(id)) return;
        const fromBlock = LangsysApp.Translations.lookupContent(category, id, tokens[0]!);
        if (fromBlock === null || fromBlock === undefined) {
            (LangsysApp.Translations.t as unknown as (p: string, c: string) => string)(tokens[0]!, category);
        }
        return;
    }
    const id = options.id ?? resolveId(root, tokens, category, undefined);
    if (isContentBlockKnown(category, id) || isServerCollected(id) || isBlockHandled(id, 'seed')) return;
    if (!activeScope()) markBlockHandled(id, 'mount');
    void registerContentBlock({ custom_id: id, category, label, content: serializeTree(input), tokens });
}

/** A seeded block: a phrase records its miss as `t()` does; an unknown block registers under its id. */
function registerSeeded(block: SeededBlock): void {
    const { customId, category, tokens, shape } = block;
    if (block.collected || isBlockHandled(customId, 'mount')) return;
    if (shape === 'phrase') {
        const fromBlock = LangsysApp.Translations.lookupContent(category, customId, tokens[0] ?? '');
        if (tokens[0] && (fromBlock === null || fromBlock === undefined)) {
            (LangsysApp.Translations.t as unknown as (p: string, c: string) => string)(tokens[0], category);
        }
        return;
    }
    if (isContentBlockKnown(category, customId)) return;
    markBlockHandled(customId, 'seed');
    void registerContentBlock({ custom_id: customId, category, content: '', tokens });
}

function registerNestedHosts(nodes: ViewNode[], options: BlockOptions, resolved = false): void {
    for (const node of nodes) {
        if (!(node instanceof ViewElement)) continue;
        const here = resolvedHere(node as unknown as Element, resolved);
        const category = nestedOptions(node, options, resolved).category ?? '';
        if (isPhraseMarked(node as unknown as Element)) {
            const toRich = (list: ViewNode[]): RichTextNode<null>[] =>
                list.flatMap((n): RichTextNode<null>[] => {
                    if (n instanceof ViewText) return [{ text: n.nodeValue }];
                    if (n instanceof ViewComment) return [];
                    return [{ children: toRich(n.childNodes), payload: null }];
                });
            const { phrase } = encodeRichPhrase(toRich(node.childNodes));
            // Text inside a resolved scope is never recorded (GATE-10).
            if (phrase && !here) (LangsysApp.Translations.t as unknown as (p: string, c: string) => string)(phrase, category);
            continue;
        }
        const marker = readContentBlockMarker(node as unknown as Element);
        if (marker) {
            // A stamp with the resolved marker is adopted and registers nothing; a
            // declaration, or a stamp without it, registers as its own block.
            const nested = nestedOptions(node, options, resolved);
            if (!nested.customId && !here) registerView(node.childNodes, nested, toBlockNodes(node.childNodes));
            continue;
        }
        if (isExcisedFromUnit(node as unknown as Element)) continue;
        registerNestedHosts(node.childNodes, options, here);
    }
}

// ---------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function serializeNode(node: BlockNode): string {
    if ('text' in node) return escapeText(node.text);
    if ('comment' in node) return `<!--${node.comment}-->`;
    const tag = node.tag.toLowerCase();
    const attrs = Object.entries(node.attrs ?? {})
        .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`))
        .join('');
    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${(node.children ?? []).map(serializeNode).join('')}</${tag}>`;
}

function escapeText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
