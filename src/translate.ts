import {
    CONTENT_BLOCK_MARKER_ATTR,
    generateCustomId,
    isContentBlockKnown,
    findSingleTextNode,
    isExcisedFromUnit,
    type WalkNode,
    isContentBlockMarked,
    isPhraseMarked,
    readContentBlockMarker,
    hostCategory,
    isInResolvedScope,
    legacyTokenizeElement,
    isMarkerOnlyUnit,
    type UnitVars,
    registerContentBlock,
    resolveHistoricalBlockId,
    tokenizeElement,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './content-block.js';
import { interpolate, isICU, normalizeMarkupPlaceholders, warnUnmatchedParams } from './interpolate.js';
import { historicalCustomIds, normalizeTokenText } from './identity.js';
import { LangsysApp } from './langsys-app.js';
import { logger } from './logger.js';
import { config as configStore, currentlyLoadedLocale, navigationEpoch, sTranslations } from './stores.js';
import type { Unsubscriber } from './signal.js';
import { claimHost, inertUnderScope, isHostManaged, releaseHost } from './hosts.js';
import { Phrase } from './phrase.js';
import { isBlockHandled, isServerCollected, markBlockHandled, recoverBlockSources, warnUnrecoveredSource } from './served-source.js';
import { warnUnregistered } from './notices.js';
import { groupRuns, renderRun, runToken, type MarkerNode, type VarMarker, type VarRun } from './var-markers.js';
import { RESOLVED_MARKER_ATTRS } from './identity.js';
import type { iContentBlock } from './types/content-block.js';
import type { ParamPrimitive } from './types/translation-fn.js';
import { isEmpty } from './utils.js';

/** Options for the `Translate` class. Matches the Svelte component's props. */
export interface TranslateOptions {
    /** Optional category under which tokens are registered. Helps translators disambiguate. */
    category?: string;
    /** Optional stable id for the content block. If omitted, we hash category+tokens. */
    custom_id?: string;
    /** Optional human-readable label shown in the Translation Manager. */
    label?: string;
    /**
     * Interpolation params — `{name}`, `{count}`, etc. Same single-brace syntax
     * as `t()`, and what you write in plain DOM. In a framework component's
     * markup write `%name%` / `%count%` instead: Svelte and JSX consume
     * `{name}` at compile time (Vue consumes `{{ name }}`), and `%name%` is
     * normalized back to `{name}` at capture.
     */
    params?: Record<string, ParamPrimitive>;
    /**
     * `false` renders from the catalog and registers nothing, on either lane (VAR-7):
     * for a binding whose content holds values from variables it cannot name without
     * its build-time transform. One debug notice says so. Default `true`.
     */
    register?: boolean;
}

type iNode = Node & { originalNodeValue?: string | null };
type iElement = HTMLElement & { originalAttributes?: Record<string, string> };

/**
 * How long a host's subtree must stay structurally quiet before the content it
 * shows is taken as settled (SRV-5): a lazy child resolving inside the window
 * replaces a loading placeholder before anything registers.
 */
const SETTLE_MS = 250;

/** The id this SDK stamped on each host this session, so our own stamp is never read as a renderer's. */
const ownStamps = new WeakMap<Element, string>();

/**
 * Wrap a DOM element and manage translation for its contents.
 *
 *   const el = document.querySelector('#hero');
 *   new Translate(el, { category: 'Home' });
 *
 * The first-pass tokenizes text nodes and translatable attributes; if the
 * content is a single text run, it's treated as a plain token. For HTML
 * content, a "content block" is registered so translators see the content
 * with the same visual structure users see.
 *
 * Call `.destroy()` to stop reacting to locale changes.
 */
export class Translate {
    private element: HTMLElement;
    private options: TranslateOptions;
    private tokens: string[] = [];
    private parseComplete = false;
    private isTokenizing = false;
    private lastTranslatedLocale = '';
    private custom_id: string;
    private unsubscribers: Unsubscriber[] = [];
    /** Sorted params key-set already checked, so value-only updates don't re-warn. */
    private checkedParamKeys: string | null = null;
    /** The block this host registered as, kept so a navigation can re-record its miss. */
    private contentBlock: iContentBlock | null = null;
    /**
     * The id a renderer stamped on this host (MARK-3's identity), adopted rather
     * than derived. Such a host renders from the catalog entry under that id, or
     * its source text, and registers nothing.
     */
    private adoptedId: string | null = null;
    /**
     * Whether an adopted host's source tokens have been recovered: its DOM holds
     * the text a server translated, never the source the catalog is keyed by.
     */
    private sourcesRecovered = false;
    /** The locale an adopted host was served in; its served text is right for that locale. */
    private servedLocale = '';
    /** What the unit's value markers say (VAR-3): the runs among its tokens, and their values. */
    private vars: UnitVars = { values: {}, runs: [], markerOnly: [] };
    /** Each marked run's source, by its first node, where it was recovered rather than read. */
    private runSources = new WeakMap<Node, string>();
    /** Each marked run's text nodes as first seen, before any render wrote them. */
    private runOriginals = new WeakMap<Node, string>();
    /** Each marked value as first seen, for a render that emptied it. */
    private markedValues = new WeakMap<Node, string>();
    /** Marked hosts inside this one that no instance managed, taken over by this walk. */
    private takenOver: Array<{ destroy(): void }> = [];
    /**
     * SRV-5: the content captured at mount is provisional. A framework can mount a
     * block showing a placeholder (a Suspense fallback, a lazy child's spinner)
     * and swap in the real content a moment later. An observer watches the host's
     * STRUCTURE (child lists, never text: a value update must not re-key a block);
     * the first registration waits until it has been quiet for `SETTLE_MS`, and a
     * later structural change re-derives the block and registers what it shows.
     */
    private observer: MutationObserver | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Whether the subtree has been quiet for the settle window since mount. */
    private settled = false;
    private settleWaiters: Array<() => void> = [];
    /** A structural change the tokens do not reflect yet. */
    private dirty = false;
    /** Whether the id is derived from the content, and so follows it when it changes. */
    private derivedId = true;

    /**
     * @param byWalk Internal: set when an enclosing walk creates this instance for
     *   a host nothing managed, so an instance the author constructs replaces it.
     */
    constructor(element: HTMLElement, options: TranslateOptions = {}, byWalk = false) {
        this.element = element;
        this.options = { ...options };
        this.custom_id = options.custom_id || '';
        // Under a request scope the render is a server's, and this class's work would
        // finish after the scope has ended: registration and subscriptions belong to
        // `renderBlock` and `registerBlock` there (SRV-7).
        if (inertUnderScope('Translate')) return;
        claimHost(element, this, byWalk);
        if (options.register === false) warnUnregistered('register-false');

        // A stamp this SDK did not write names the host's id (MARK-3). Inside a resolved
        // scope, the host itself or its nearest marked ancestor carrying data-ls-resolved,
        // a renderer already rendered the block from the catalog: adopt the id, render
        // under it, register nothing. Outside one, it is the block's id, app-chosen or
        // derived, to render and register under when the catalog lacks it. Our own stamp,
        // on an element re-mounted in the same session, is only the id we derived.
        // The app's own `custom_id`, when it names the stamp, is the same identity: a
        // server rendered the block under it, and the served text is still a translation.
        const marker = readContentBlockMarker(element);
        if (
            marker?.kind === 'identity' &&
            ownStamps.get(element) !== marker.id &&
            (!this.custom_id || this.custom_id === marker.id)
        ) {
            this.custom_id = marker.id;
            if (isInResolvedScope(element)) this.adoptedId = marker.id;
        }
        this.derivedId = !this.custom_id;
        this.observeStructure();

        // First pass: tokenize + save + translate.
        void this.tokenizeContent();

        // React to locale changes.
        this.unsubscribers.push(
            currentlyLoadedLocale.subscribe((locale) => {
                if (locale && this.parseComplete) this.translateUpdate(locale);
            })
        );

        // The catalog changing is a separate event from the locale changing,
        // and only one of them was observed. A same-locale catalog arrival —
        // the first fetch completing, a `refresh()`, a token-flush write-back —
        // replaces `sTranslations` while `currentlyLoadedLocale` keeps its
        // value, so a locale-only subscription sees nothing and the element
        // keeps showing its source text with a correct catalog in the store.
        this.unsubscribers.push(
            sTranslations.subscribe(() => {
                if (!this.parseComplete) return;
                const locale = currentlyLoadedLocale.get();
                if (!locale) return;
                // The guard in translateUpdate short-circuits on an unchanged
                // locale, which is precisely this case — clear it so the walk
                // actually runs.
                this.lastTranslatedLocale = '';
                this.translateUpdate(locale);
            })
        );

        // HINT-13. `subscribe` fires once with the current value; only later advances mean
        // a navigation.
        let initialNavigation = true;
        this.unsubscribers.push(
            navigationEpoch.subscribe(() => {
                if (initialNavigation) {
                    initialNavigation = false;
                    return;
                }
                this.reenterAfterNavigation();
            })
        );
    }

    /**
     * HINT-13: after `notifyNavigation()`, re-enter the lookup as a re-render would, so a miss is
     * recorded at the page's new URL — only while the host is attached to the document. An
     * instance whose node was removed but never destroyed stays subscribed, and re-entering it
     * would report the old page's content for the new one.
     */
    private reenterAfterNavigation(): void {
        if (!this.parseComplete || !this.element?.isConnected || this.adoptedId || !this.registers()) return;
        const { category = '' } = this.options;
        if (this.usesSingleTextNodeFastPath()) {
            this.renderSingleToken(category);
            return;
        }
        // A block that is still unknown is recorded again; `registerContentBlock` applies
        // every lane rule. A registered or resolved one records nothing, and a block inside
        // a resolved scope never did.
        if (
            this.contentBlock &&
            !isContentBlockKnown(this.contentBlock.category, this.custom_id) &&
            !isInResolvedScope(this.element) &&
            !isServerCollected(this.custom_id)
        ) {
            void registerContentBlock({ ...this.contentBlock, custom_id: this.custom_id });
        }
    }

    /** Update interpolation params (e.g. a changed count) and re-render. Mirrors `Phrase.setParams`. */
    public setParams(params: Record<string, ParamPrimitive> | undefined): void {
        this.options.params = params;
        // Checked independently of `parseComplete` — tokens are known before
        // content-block registration settles, and params can change during
        // that window.
        this.checkParams();
        if (!this.parseComplete) return;
        this.lastTranslatedLocale = '';
        const locale = currentlyLoadedLocale.get();
        if (locale) this.translateUpdate(locale);
    }

    /**
     * Watch the host's structure (SRV-5). Not for an adopted host or one in a
     * resolved scope: served content is already what it shows, and registers
     * nothing. Where there is no `MutationObserver`, the content is settled at mount.
     */
    private observeStructure(): void {
        if (this.adoptedId || isInResolvedScope(this.element) || typeof MutationObserver === 'undefined') {
            this.markSettled();
            return;
        }
        this.observer = new MutationObserver((records) => {
            if (!records.some((record) => this.isUnitStructure(record.target))) return;
            this.dirty = true;
            this.armSettle();
        });
        this.observer.observe(this.element, { childList: true, subtree: true });
        this.armSettle();
    }

    /**
     * Whether a changed child list belongs to this unit. An excised subtree, and
     * each nested host, is another instance's. An `<option>`'s list is changed only
     * by this class, writing its text.
     */
    private isUnitStructure(target: Node): boolean {
        for (let node: Node | null = target; node && node !== this.element; node = node.parentNode) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const element = node as Element;
            if (element.localName === 'option' || isExcisedFromUnit(element)) return false;
        }
        return true;
    }

    private armSettle(): void {
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            // Read again before settling, so the new read is the one that registers.
            if (this.dirty && this.parseComplete && !this.isTokenizing) void this.rederive();
            this.markSettled();
        }, SETTLE_MS);
    }

    private markSettled(): void {
        if (this.settled) return;
        this.settled = true;
        this.settleWaiters.forEach((resolve) => resolve());
        this.settleWaiters = [];
    }

    private whenSettled(): Promise<void> {
        if (this.settled) return Promise.resolve();
        return new Promise((resolve) => this.settleWaiters.push(resolve));
    }

    /**
     * The block's structure changed after it was read: read it again, under the id
     * its content now derives (an app's or a stamped id stays), stamp it, render it,
     * and register it if unknown. An id already sent for the earlier content stays
     * registered; the core cannot take a registration back.
     */
    private async rederive(): Promise<void> {
        this.dirty = false;
        this.takenOver.forEach((instance) => instance.destroy());
        this.takenOver = [];
        if (this.derivedId) this.custom_id = '';
        this.contentBlock = null;
        this.parseComplete = false;
        this.lastTranslatedLocale = '';
        await this.tokenizeContent();
    }

    /** Stop reacting to locale and catalog changes. Safe to call multiple times. */
    public destroy() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = null;
        this.unsubscribers.forEach((unsub) => unsub());
        this.unsubscribers = [];
        this.takenOver.forEach((instance) => instance.destroy());
        this.takenOver = [];
        releaseHost(this.element, this);
    }

    /**
     * Take over every marked host inside this one that no instance manages
     * (MARK-2, MARK-3). The walk excises such a host from this unit (MARK-4), and
     * without an instance of its own it would never register: a phrase host
     * registers whole, as the one string its markup defines, and a block host
     * registers as its own block or, when it carries a stamped id, renders under
     * that id and registers nothing. Excluded subtrees are not entered, and a
     * marked host's own inside is its instance's to walk.
     */
    private takeOverUnmanagedHosts(): void {
        const { params, label } = this.options;
        const visit = (parent: Element) => {
            for (const child of Array.from(parent.children)) {
                // A nested host's own category when it names one (`data-ls-category`).
                const category = hostCategory(child) ?? this.options.category;
                if (isPhraseMarked(child)) {
                    if (!isHostManaged(child)) this.takenOver.push(new Phrase(child as HTMLElement, { category, params, register: this.options.register }, true));
                } else if (isContentBlockMarked(child)) {
                    if (!isHostManaged(child)) {
                        this.takenOver.push(new Translate(child as HTMLElement, { category, params, label, register: this.options.register }, true));
                    }
                } else if (!isExcisedFromUnit(child)) {
                    visit(child);
                }
            }
        };
        visit(this.element);
    }

    private translateUpdate(currentLocale: string) {
        if (!this.element?.innerHTML || !this.parseComplete) return;
        if (this.lastTranslatedLocale === currentLocale) return;

        const { category = '' } = this.options;

        if (this.usesSingleTextNodeFastPath()) {
            this.renderSingleToken(category);
            this.lastTranslatedLocale = currentLocale;
        } else {
            if (!this.recoverServedSources(currentLocale !== this.servedLocale)) return;
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentLocale;
            if (this.adoptedId) this.restampResolvedLocale(currentLocale);
        }
    }

    /**
     * An adopted host holds the text a renderer served, a translation when the
     * page was served in another locale, and the catalog is keyed by source. Its
     * source tokens come from the scope's seed, or the catalog entry the served text
     * was rendered from, never from the DOM (SRV-4): each text node and attribute is
     * given its source as the original it renders from. Until they are recovered the
     * host is left as served, which is right for the locale it was served in; a
     * later switch tries again, since a binding may hand the seed over after mount.
     */
    /**
     * An adopted host re-rendered in another locale names that locale in its own
     * resolved marker, so the marker keeps describing the text it holds. A marker
     * with no locale (bare, `true`) is left as it is.
     */
    private restampResolvedLocale(locale: string): void {
        for (const attr of RESOLVED_MARKER_ATTRS) {
            const value = this.element.getAttribute(attr);
            if (value === null) continue;
            if (!['', 'true', '1', 'yes'].includes(value.trim().toLowerCase()) && value !== locale) this.element.setAttribute(attr, locale);
            return;
        }
    }

    private recoverServedSources(warn: boolean): boolean {
        if (!this.adoptedId || this.sourcesRecovered) return true;
        const { category = '', params = {} } = this.options;
        const recovered = recoverBlockSources(this.element, this.adoptedId, category, params);
        if (!recovered) {
            if (warn) warnUnrecoveredSource();
            return false;
        }
        recovered.slots.forEach((slot, i) => {
            const source = recovered.sources[i]!;
            if (slot.run) {
                // A marked run's source is its template; its values stay the framework's.
                this.runSources.set(this.runKey(slot.run), source);
            } else if (slot.attr) {
                const element = slot.node as iElement;
                (element.originalAttributes ??= {})[slot.attr] = source;
            } else {
                const node = slot.node as iNode;
                const value = node.nodeValue ?? '';
                node.originalNodeValue = value.match(/^\s*/)![0] + source + value.match(/\s*$/)![0];
            }
        });
        this.tokens = recovered.sources;
        this.sourcesRecovered = true;
        this.checkParams();
        return true;
    }

    /**
     * Render a single-token block.
     *
     * Prefers the content-block entry: the token may be stored as a block —
     * registered under an explicit `custom_id`, by an older SDK, or seeded
     * server-side — and flat `t()` cannot see inside block entries, so it would
     * report a miss for content that is present. Falls back to `t()`, which
     * also queues the miss for registration.
     */
    private renderSingleToken(category: string): void {
        const token = this.tokens[0];
        const fromBlock = LangsysApp.Translations.lookupContent(category, this.custom_id, token);
        // The params go INTO `t()`, never onto its result. `t()` renders ICU without
        // params too (ICU-1), so a select in its output has already collapsed to
        // `other`, and interpolating that again can no longer choose by the params
        // supplied here: with `{g: 'female'}` it rendered "They left".
        const tWithParams = LangsysApp.Translations.t as unknown as (
            phrase: string,
            category: string,
            params: Record<string, unknown>
        ) => string;
        // The producer says text in a resolved scope is already resolved, so it is a
        // translation and not a source phrase: render from the catalog if we happen to
        // hold it, else leave what the server served, and record nothing on either lane.
        // A block the server's scope sends itself is recorded there, never again here;
        // and a unit that does not register records nothing at all (VAR-7).
        const records = this.settled && this.registers() && !isInResolvedScope(this.element) && !isServerCollected(this.custom_id);
        const found = fromBlock !== null && fromBlock !== undefined;

        if (this.isSingleRun()) {
            // One sentence with its values (VAR-3): recorded as its template, written
            // around the values the framework owns.
            if (!found && records) tWithParams(token, category, { ...this.vars.values, ...(this.options.params ?? {}) });
            const run = this.findRun();
            if (run) this.writeRun(run, found ? fromBlock : (LangsysApp.Translations.lookup(token, category) ?? token));
            return;
        }

        let resolved: string;
        if (found) {
            resolved = this.applyParams(fromBlock);
        } else if (!records) {
            resolved = this.applyParams(LangsysApp.Translations.lookup(token, category) ?? token);
        } else {
            resolved = tWithParams(token, category, this.options.params ?? {});
        }

        // Write the ONE text node. Never `innerText`, which replaces every
        // child of the host element: a single-token block still commonly wraps
        // its text in markup — `<Translate><p data-testid="x">text</p></Translate>`
        // is the ordinary framework-component shape — and flattening it destroys
        // the wrapper along with any test id, id, ref or framework anchor on it.
        //
        // There is no `innerText` fallback on purpose. Both callers gate on
        // `usesSingleTextNodeFastPath()`, so the node is guaranteed to exist;
        // an unreachable fallback that quietly does the destructive thing is
        // how this defect would come back the next time someone widens the
        // routing. If it is ever null, that is a routing bug and should be
        // visible as one rather than absorbed into a wiped subtree.
        const textNode = this.findSingleTextNode(this.element);
        if (!textNode) {
            logger.warn(
                'Translate: single-token fast path reached an element with no text node — this is a routing bug, ' +
                    'not a content problem. Leaving the DOM untouched rather than replacing it.'
            );
            return;
        }
        textNode.nodeValue = resolved;
    }

    /**
     * Whether the single-token fast path may claim this element.
     *
     * "One token" is NOT the same question as "one text node", and treating
     * them as one was the defect. A translatable ATTRIBUTE is also a token, and
     * an element carrying only an attribute token — `<img alt="…">`,
     * `<input placeholder="…">` — has no text node anywhere in its subtree. The
     * fast path would then write the translation as the element's text, and the
     * element itself is gone.
     *
     * So the fast path requires an actual text node to write into. Everything
     * else goes to the node-walking path, which already translates attributes
     * in place and recurses, so a token on a nested element is reached too.
     */
    private usesSingleTextNodeFastPath(): boolean {
        // An adopted id is a block's (MARK-1 stamps blocks), and the fast path would
        // register the token as a phrase.
        if (this.adoptedId) return false;
        return this.tokens.length === 1 && (this.findSingleTextNode(this.element) !== null || this.isSingleRun());
    }

    /** A unit whose one token is a marked run is a phrase too (VAR-3, TOK-6): one sentence, with its values. */
    private isSingleRun(): boolean {
        return this.tokens.length === 1 && this.vars.runs.includes(0);
    }

    /** Whether this unit registers: not with `register: false`, and not when it is made only of markers (VAR-3, VAR-7). */
    private registers(): boolean {
        return this.options.register !== false && !isMarkerOnlyUnit(this.tokens, this.vars);
    }

    /**
     * The unique non-whitespace text node under `root`, or `null` when there is
     * none or more than one — in which case the caller falls back to a flat
     * text render, since there is no single place to put the result.
     */
    /**
     * Publish the resolved `custom_id` on the host element.
     *
     * A server-rendered page is otherwise unreadable: the id is derivable only
     * by re-running the tokenizer over the same subtree, which a reader holding
     * just the HTML cannot do identically — and the tokenizer's own rules are
     * what decide it. Stamping it makes the block self-describing, the same way
     * a `Phrase` host already carries `PHRASE_MARKER_ATTR`.
     *
     * Written on every resolution, including when the migration fallback adopts
     * a legacy id, so the attribute always names the id actually in use rather
     * than the one first derived.
     */
    private stampContentBlockMarker(): void {
        if (!this.element || !this.custom_id) return;
        this.element.setAttribute(CONTENT_BLOCK_MARKER_ATTR, this.custom_id);
        ownStamps.set(this.element, this.custom_id);
    }

    /** The unit's first marked run, where its single-run token comes from. */
    private findRun(): VarRun<Node> | null {
        const visit = (parent: Node): VarRun<Node> | null => {
            for (const item of groupRuns(parent.childNodes as unknown as ArrayLike<MarkerNode>) as unknown as Array<{ node: Node } | { run: VarRun<Node> }>) {
                if ('run' in item) return item.run;
                if (item.node.nodeType !== Node.ELEMENT_NODE || isExcisedFromUnit(item.node as Element)) continue;
                const found = visit(item.node);
                if (found) return found;
            }
            return null;
        };
        return visit(this.element);
    }

    /** The node a run is known by: its first text node or marker. */
    private runKey(run: VarRun<Node>): Node {
        const first = run.parts[0]!;
        return 'text' in first ? first.text : first.marker.frame[0]!;
    }

    /** A run text node's text before any render wrote it. */
    private runOriginal(node: Node): string {
        let original = this.runOriginals.get(node);
        if (original === undefined) {
            original = normalizeMarkupPlaceholders(node.nodeValue ?? '');
            this.runOriginals.set(node, original);
        }
        return original;
    }

    /** A marked value: the text the framework shows now, or, where a render emptied it, what it showed. */
    private markedValue(marker: VarMarker<Node>): string {
        const key = marker.value[0] ?? marker.frame[0]!;
        const shown = normalizeTokenText(marker.value.map((node) => node.nodeValue ?? '').join(''));
        if (shown) this.markedValues.set(key, shown);
        return shown || (this.markedValues.get(key) ?? '');
    }

    /** Write `template` into a marked run, around its values where it can (see `renderRun`). */
    private writeRun(run: VarRun<Node>, template: string): void {
        const writes = renderRun(run as unknown as VarRun<MarkerNode>, template, this.options.params ?? {}, currentlyLoadedLocale.get(), {
            text: (node) => this.runOriginal(node as unknown as Node),
            value: (marker) => this.markedValue(marker as unknown as VarMarker<Node>),
        });
        for (const [node, text] of writes) if (node.nodeValue !== text) node.nodeValue = text;
    }

    /** A marked run inside a block: its translation under the block's id, else its source. */
    private translateRun(run: VarRun<Node>): void {
        const source = this.runSources.get(this.runKey(run)) ?? runToken(run as unknown as VarRun<MarkerNode>, (node) => this.runOriginal(node as unknown as Node));
        this.writeRun(run, this.getTranslation(source) ?? source);
    }

    private findSingleTextNode(root: Node): Node | null {
        return findSingleTextNode(root as unknown as { childNodes: ArrayLike<Node & WalkNode> });
    }

    private async tokenizeContent(): Promise<boolean> {
        if (this.isTokenizing) return false;
        if (!this.element || !this.element.childNodes.length) {
            this.parseComplete = true;
            this.isTokenizing = false;
            return false;
        }

        this.isTokenizing = true;

        // Framework-agnostic tokenization + style-snapshot lives in
        // content-block.ts. We store the clone locally only because the
        // existing translate() DOM-mutator references it for content-block
        // detection (`this.tokens` drives the single-vs-multi branch below).
        const { tokens, content, vars } = tokenizeElement(this.element);
        this.tokens = tokens;
        this.vars = vars;
        this.checkParams();
        this.takeOverUnmanagedHosts();

        const { category = '' } = this.options;

        if (this.usesSingleTextNodeFastPath()) {
            // Derive the id even for a single token: without one there is
            // nothing to look the block up BY, so a single-token block stored
            // in the catalog could never be found and would re-register on
            // every visit.
            if (isEmpty(this.custom_id)) {
                this.custom_id = generateCustomId(category, this.tokens);
            }
            this.stampContentBlockMarker();
            this.renderSingleToken(category);
            // Rendered at once, recorded once the content has settled (SRV-5).
            if (!this.settled) {
                void this.whenSettled().then(() => {
                    if (!this.dirty && this.usesSingleTextNodeFastPath()) this.renderSingleToken(category);
                });
            }
        } else {
            const contentBlock: iContentBlock = {
                custom_id: '',
                category,
                label: this.options.label,
                content,
                tokens: this.tokens,
            };
            await this.handleContentBlock(contentBlock);
        }

        this.parseComplete = true;
        this.isTokenizing = false;
        // The structure changed while this read was in flight: read it again (SRV-5).
        if (this.dirty && this.settled) void this.rederive();
        return true;
    }

    private async handleContentBlock(contentBlock: iContentBlock) {
        if (this.adoptedId) {
            // A stamped identity: render from the catalog entry under it, or leave the
            // source text, and register nothing (MARK-3).
            await LangsysApp.Translations.ready();
            if (this.element) {
                if (this.recoverServedSources(false)) this.translate(Array.from(this.element.childNodes));
                // The host shows this locale either way: rendered now, or as served.
                this.lastTranslatedLocale = this.servedLocale = currentlyLoadedLocale.get();
            }
            return;
        }
        this.contentBlock = contentBlock;
        const derivedId = isEmpty(this.custom_id);
        if (derivedId) {
            this.custom_id = generateCustomId(contentBlock.category, contentBlock.tokens);
        }
        contentBlock.custom_id = this.custom_id;
        this.stampContentBlockMarker();

        // Wait for the first GET /translations to settle before deciding whether
        // to POST — otherwise on a cold cache the lookup misses and we'd POST
        // every CB on every first visit even when the backend already has it.
        await LangsysApp.Translations.ready();

        if (isContentBlockKnown(contentBlock.category, this.custom_id)) {
            // Backend already has this block — translate locally, no POST.
            if (!this.usesSingleTextNodeFastPath() && this.element) {
                this.translate(Array.from(this.element.childNodes));
                this.lastTranslatedLocale = currentlyLoadedLocale.get();
            }
            return;
        }

        // Migration fallback, LOOKUP ONLY (CID-3). A block an older SDK registered
        // is stored under an id this SDK no longer emits, and its translations must
        // keep resolving instead of orphaning. `historicalCustomIds` lists every shape
        // the fleet's shared legacy fixture names; registration below still uses the
        // corrected id, so the legacy-keyed population can only shrink. Skipped for a
        // caller-supplied custom_id, since nothing was derived.
        //
        // A historical hit is attached only when the stored block holds this block's
        // phrases (CID-4). It used to attach on the id being present, and none of these
        // id spaces is injective, so a collision filed this block under a foreign id
        // and it never registered its own content.
        if (derivedId) {
            const candidates = historicalCustomIds(
                contentBlock.category,
                contentBlock.tokens,
                legacyTokenizeElement(this.element)
            ).filter((id) => id !== this.custom_id);
            const resolved = resolveHistoricalBlockId(contentBlock.category, candidates, contentBlock.tokens);
            if (resolved) {
                this.custom_id = resolved;
                // The fallback just changed which id is in use; the attribute
                // must follow, or it names an id nothing resolves under.
                this.stampContentBlockMarker();
                if (!this.usesSingleTextNodeFastPath() && this.element) {
                    this.translate(Array.from(this.element.childNodes));
                    this.lastTranslatedLocale = currentlyLoadedLocale.get();
                }
                return;
            }
        }

        // Not `tokens.length > 1`: an attribute-only block has ONE token and
        // still belongs here, and that guard is what would silently skip its
        // render after the routing above sent it down this path.
        if (!this.usesSingleTextNodeFastPath() && this.element) {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentlyLoadedLocale.get();
        }

        // SRV-5: register what the host shows once it has settled, never a placeholder
        // it showed at mount. A structural change in the meantime means this read is
        // stale, and the read that follows it registers instead.
        await this.whenSettled();
        if (this.dirty) return;

        // Fire-and-forget: registerContentBlock handles its own errors via
        // the logger. We don't await here because the DOM render path below
        // doesn't depend on the POST completing — translations are looked up
        // from sTranslations on every render, which updates reactively when
        // the GET response arrives.
        if (!this.registers()) {
            // `register: false`, or a unit made only of value markers (VAR-7, VAR-3).
            logger.log('Skipping content block registration: this unit registers nothing');
        } else if (isBlockHandled(this.custom_id, 'seed')) {
            // Already sent on this page from the scope's seed.
            logger.log('Skipping content block registration: the seed already sent it');
        } else if (isServerCollected(this.custom_id)) {
            // The server's request scope sends this block itself after the response (its
            // seed says so), so sending it from the client would register it twice.
            logger.log('Skipping content block registration: the server registers this block');
        } else if (isInResolvedScope(this.element)) {
            // The same rule one level up: a block inside a resolved scope holds translated
            // text, so registering it would file a translation as source, and the hint lane
            // inside `registerContentBlock` would report the localized page. Identity is
            // untouched — the marker stamped above still names this block.
            logger.log('Skipping content block registration: the host sits in a resolved scope');
        } else {
            markBlockHandled(this.custom_id, 'mount');
            void registerContentBlock(contentBlock);
        }

    }

    private translate(nodes: iNode[]) {
        const currentLocale = currentlyLoadedLocale.get();
        // With params, the base locale still needs a pass — placeholders must
        // be interpolated even when no translation lookup will hit. So does a
        // block carrying ICU without params, which renders its `other` branch
        // rather than its raw source (ICU-1).
        if (
            currentLocale === configStore.baseLocale &&
            (this.lastTranslatedLocale === '' || this.lastTranslatedLocale === configStore.baseLocale) &&
            isEmpty(this.options.params) &&
            !this.tokens.some((token) => isICU(token))
        ) {
            return;
        }

        for (const item of groupRuns(nodes as unknown as MarkerNode[]) as unknown as Array<{ node: iNode } | { run: VarRun<Node> }>) {
            if ('run' in item) {
                this.translateRun(item.run);
                continue;
            }
            const node = item.node;
            if (node?.nodeType === Node.ELEMENT_NODE) {
                // Only this unit's text is rendered: what the tokenizer left out, it did
                // not register, and a phrase host or a nested block renders itself.
                if (isExcisedFromUnit(node as HTMLElement)) continue;
                this.translateAttributes(node as iElement);
            }

            if (node?.nodeType !== Node.TEXT_NODE) {
                if (!node?.hasChildNodes()) continue;
                this.translate(Array.from(node.childNodes));
                continue;
            }

            if (isEmpty(normalizeTokenText(node.nodeValue ?? ''))) continue;

            if (isEmpty(node.originalNodeValue)) {
                // Snapshot in canonical placeholder form so lookups, replaces,
                // and interpolation all operate on `{key}`.
                node.originalNodeValue = normalizeMarkupPlaceholders(node.nodeValue!);
            }

            // The LOOKUP key, and it must be the key registration derived. Both sides
            // call `normalizeTokenText` so there is one definition of it: a second copy
            // of the same regex agreed today and would not have followed a change.
            const contentToken = node.originalNodeValue ? normalizeTokenText(node.originalNodeValue) : undefined;
            if (!contentToken) continue;

            const translation = this.getTranslation(contentToken);

            if (translation && contentToken && node.originalNodeValue) {
                // Replacer fn so `$`-patterns in translations/params stay literal.
                const resolved = this.applyParams(translation);
                node.nodeValue = node.originalNodeValue.replace(contentToken, () => resolved);
            } else if (node.originalNodeValue) {
                node.nodeValue = this.applyParams(node.originalNodeValue);
            }
        }
    }

    private getTranslation(token: string): string | null {
        if (!token) return null;
        const { category = '' } = this.options;
        return LangsysApp.Translations.lookupContent(category, this.custom_id, token);
    }

    /**
     * Debug-time check that every supplied param has a placeholder to land in.
     * Re-runs only when the key SET changes — a changing `count` value must not
     * re-warn on every render.
     */
    private checkParams(): void {
        // Before tokenization there's nothing to match against — every key
        // would look unused. Skip without recording, so the check still runs
        // once tokens exist. An adopted host's tokens are its served text until
        // its source is recovered, and the params are the source's.
        if (!this.tokens.length || (this.adoptedId && !this.sourcesRecovered)) return;

        const { params, category = '' } = this.options;
        const signature = params ? Object.keys(params).sort().join(',') : '';
        if (signature === this.checkedParamKeys) return;
        this.checkedParamKeys = signature;

        warnUnmatchedParams('<Translate>', this.tokens, params, category || undefined);
    }

    /**
     * Interpolate `{name}`-style params into a resolved text, matching `t()`:
     * unknown keys fall through untouched, and the untranslated fallback is
     * interpolated too. Runs without params as well, since a text carrying ICU
     * renders its `other` branch rather than its raw source (ICU-1). Plain text,
     * braces included, comes back exactly as written.
     */
    private applyParams(text: string): string {
        return interpolate(text, this.options.params ?? {}, currentlyLoadedLocale.get());
    }

    private translateAttributes(element: iElement) {
        const tagName = element.tagName.toLowerCase();
        if (!element.originalAttributes) element.originalAttributes = {};

        for (const attr of TRANSLATABLE_ATTRIBUTES) {
            this.translateAttribute(element, attr);
        }

        if (VALUE_TRANSLATABLE_ELEMENTS.includes(tagName)) {
            this.translateAttribute(element, 'value');
        }

        if (tagName === 'input') {
            const inputType = element.getAttribute('type')?.toLowerCase();
            if (inputType && VALUE_TRANSLATABLE_INPUT_TYPES.includes(inputType)) {
                this.translateAttribute(element, 'value');
            }
        }

        if (tagName === 'select') {
            const options = element.querySelectorAll('option');
            options.forEach((option) => {
                const optionEl = option as iElement;
                if (!optionEl.originalAttributes) optionEl.originalAttributes = {};
                if (optionEl.originalAttributes['textContent'] === undefined) {
                    optionEl.originalAttributes['textContent'] = normalizeMarkupPlaceholders(option.textContent || '');
                }
                const originalText = normalizeTokenText(optionEl.originalAttributes['textContent']);
                if (originalText) {
                    const translation = this.getTranslation(originalText);
                    const text = this.applyParams(translation || optionEl.originalAttributes['textContent']);
                    // Into the option's own text node when it has just one, so a framework's
                    // reference to it stays live; `textContent =` would replace it.
                    const only = option.childNodes.length === 1 ? option.firstChild : null;
                    if (only && only.nodeType === Node.TEXT_NODE) {
                        if (only.nodeValue !== text) only.nodeValue = text;
                    } else {
                        option.textContent = text;
                    }
                }
            });
        }
    }

    private translateAttribute(element: iElement, attr: string) {
        const currentValue = element.getAttribute(attr);
        if (!currentValue) return;

        if (element.originalAttributes![attr] === undefined) {
            element.originalAttributes![attr] = normalizeMarkupPlaceholders(currentValue);
        }

        // Lookup key, derived exactly as registration derives the token. It was
        // `.trim()` alone, while TOK-4 made registration collapse internal whitespace,
        // so any attribute value with a line break or doubled space was stored under
        // one key and asked for under another, and never showed its translation.
        // The fallback below still writes the ORIGINAL value, whitespace and all.
        const originalValue = normalizeTokenText(element.originalAttributes![attr]);
        if (!originalValue) return;

        const translation = this.getTranslation(originalValue);
        if (translation) element.setAttribute(attr, this.applyParams(translation));
        else element.setAttribute(attr, this.applyParams(element.originalAttributes![attr]));
    }

}

export default Translate;
