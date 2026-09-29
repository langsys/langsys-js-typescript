import { interpolate, warnUnmatchedParams } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { applyInPlace, encodeRichText, markupTokenValues, reconstitute, type RichSlot } from './richtext.js';
import type { Unsubscriber } from './signal.js';
import { currentlyLoadedLocale, navigationEpoch, sTranslations } from './stores.js';
import type { ParamPrimitive } from './types/translation-fn.js';

/**
 * Attribute marker the `Translate` tokenizer uses to skip a `<Phrase>` subtree.
 * Re-exported, never restated: one definition lives in `content-block.ts`,
 * where the tokenizer that has to recognise it also lives.
 */
export { PHRASE_MARKER_ATTR } from './content-block.js';
import { isInResolvedScope } from './content-block.js';
import { claimHost, inertUnderScope, releaseHost } from './hosts.js';
import { warnUnregistered } from './notices.js';
import { paramElementName, type MarkerNode } from './var-markers.js';
import { recoverPhraseSource } from './served-source.js';

export interface PhraseOptions {
    /** Category the phrase registers under (disambiguation for translators). */
    category?: string;
    /**
     * Interpolation params — `{n}` for pluralization, `{name}`, etc.
     *
     * Those are the canonical spellings, and what you write in plain DOM. In a
     * framework component's markup write `%n%` / `%name%` instead: Svelte and
     * JSX consume `{n}` at compile time (Vue consumes `{{ n }}`), and `%n%` is
     * normalized back to `{n}` at capture.
     */
    params?: Record<string, ParamPrimitive>;
    /**
     * `false` renders from the catalog and registers nothing (VAR-7): for a binding
     * whose phrase holds values from variables it cannot name without its build-time
     * transform. One debug notice says so. Default `true`.
     */
    register?: boolean;
}

/**
 * DOM handler for a markup-bearing "rich" phrase (`<Phrase>`).
 *
 * Wraps an element whose inner content is ONE translatable phrase even though
 * it contains inline markup. On mount it encodes the subtree to a single phrase
 * string with neutral `{mNo}`/`{mNc}` markup tokens (the real elements stay in
 * the SDK — see richtext.ts), registers it, and renders the translation by
 * reconstituting the original elements around the translated text. Re-renders
 * on locale change and whenever params change.
 *
 *   new Phrase(el, { category: 'ProductCard', params: { n: reviewCount } });
 */
export class Phrase {
    private host: HTMLElement;
    private category: string;
    private params: Record<string, ParamPrimitive>;
    private register: boolean;
    /** Each marked value in the host (VAR-3), by name: params the caller's own override. */
    private values: Record<string, string> = {};
    private phrase = '';
    private slots: RichSlot[] = [];
    /**
     * The markup slot each element in the host renders. An element's place is its
     * slot only while the host shows the source's order; a translation that
     * reorders its markup, served or rendered here, moves them.
     */
    private slotOf = new WeakMap<Element, number>();
    /** A served translation whose source phrase is not recovered yet (see `recoverServed`). */
    private servedUnrecovered = false;
    private unsubscribers: Unsubscriber[] = [];
    private ready = false;
    /** Sorted params key-set already checked, so value-only updates don't re-warn. */
    private checkedParamKeys: string | null = null;

    /**
     * @param byWalk Internal: set when an enclosing walk creates this instance for
     *   a host nothing managed, so an instance the author constructs replaces it.
     */
    constructor(host: HTMLElement, options: PhraseOptions = {}, byWalk = false) {
        this.host = host;
        this.category = options.category ?? '';
        this.params = options.params ?? {};
        this.register = options.register !== false;
        // Under a request scope, see `Translate`: `renderBlock` and `registerBlock` there.
        if (inertUnderScope('Phrase')) return;
        claimHost(host, this, byWalk);
        if (!this.register) warnUnregistered('register-false');

        void this._init();

        // Re-render on locale switch AND when translations arrive (async MT may
        // land this phrase's translation after mount, same as the reactive `t`
        // store). subscribe fires immediately; the `ready` guard suppresses the
        // pre-init call.
        const rerender = () => {
            if (this.ready) this._render();
        };
        this.unsubscribers.push(currentlyLoadedLocale.subscribe(rerender));
        this.unsubscribers.push(sTranslations.subscribe(rerender));

        // HINT-13: after a navigation, look the phrase up again so a miss is recorded at the
        // new URL — only while the host is attached to the document, and never inside a
        // resolved scope. `subscribe` fires once with the current value first.
        let initialNavigation = true;
        this.unsubscribers.push(
            navigationEpoch.subscribe(() => {
                if (initialNavigation) {
                    initialNavigation = false;
                    return;
                }
                if (!this.ready || !this.phrase || !this.register || !this.host.isConnected || isInResolvedScope(this.host)) return;
                LangsysApp.Translations.t(this.phrase, this.category);
            })
        );
    }

    /** Update interpolation params (e.g. a changed count) and re-render. */
    public setParams(params: Record<string, ParamPrimitive> | undefined): void {
        this.params = params ?? {};
        // Checked independently of `ready` — the phrase is encoded before
        // registration settles, and params can change during that window.
        this._checkParams();
        if (!this.ready) return;
        this._render();
    }

    /** Stop reacting to locale/translation changes. Safe to call multiple times. */
    public destroy(): void {
        this.unsubscribers.forEach((unsub) => unsub());
        this.unsubscribers = [];
        releaseHost(this.host, this);
    }

    private async _init(): Promise<void> {
        if (!this.host || !this.host.childNodes.length) {
            this.ready = true;
            return;
        }

        const { phrase, slots, values } = encodeRichText(this.host);
        this.phrase = phrase;
        this.slots = slots;
        this.values = values;
        hostElements(this.host).forEach((element, i) => this.slotOf.set(element, i));
        this._checkParams();

        // Register the phrase (triggers the missing-token POST on a cache miss).
        // We ignore t()'s interpolated return — Phrase renders itself so it can
        // supply the markup-token sentinel values and reconstitute real elements.
        await LangsysApp.Translations.ready();
        // Not inside a resolved scope: there the host's text is a translation a server
        // produced, and `t()` is the call that would register it as a source phrase.
        // Nor with `register: false` (VAR-7), nor for a phrase made only of value markers,
        // which has no text of its own (VAR-3).
        if (isInResolvedScope(this.host)) this.servedUnrecovered = !this.recoverServed();
        else if (this.register && !(Object.keys(values).length && isOnlyPlaceholders(this.phrase))) LangsysApp.Translations.t(this.phrase, this.category);

        this.ready = true;
        this._render();
    }

    /**
     * Debug-time check that every supplied param has a placeholder to land in.
     * Re-runs only when the key SET changes — a changing `n` value must not
     * re-warn on every render.
     */
    private _checkParams(): void {
        // Before encoding there's nothing to match against — skip without
        // recording, so the check still runs once the phrase exists.
        if (!this.phrase) return;

        const signature = Object.keys(this.params).sort().join(',');
        if (signature === this.checkedParamKeys) return;
        this.checkedParamKeys = signature;

        warnUnmatchedParams('<Phrase>', [this.phrase], this.params, this.category || undefined);
    }

    /**
     * Inside a resolved scope the host holds a translation a server served, and the
     * catalog is keyed by source: the source phrase is the one catalog entry that
     * renders as the served text (`recoverPhraseSource`), never the DOM's text. Its
     * elements are mapped to the source's slots by the order the served translation
     * opened them. Until it is recovered the host renders from its served text,
     * which is right for the locale it was served in.
     */
    private recoverServed(): boolean {
        const recovered = recoverPhraseSource(this.phrase, this.slots.length, this.category, this.params);
        if (!recovered) return false;
        const served = this.slots;
        const slots: RichSlot[] = [];
        hostElements(this.host).forEach((element, j) => {
            const source = recovered.order[j]!;
            this.slotOf.set(element, source);
            slots[source] = served[j]!;
        });
        this.phrase = recovered.phrase;
        this.slots = slots;
        return true;
    }

    private _render(): void {
        if (!this.phrase) return;
        if (this.servedUnrecovered) this.servedUnrecovered = !this.recoverServed();

        const raw = LangsysApp.Translations.lookup(this.phrase, this.category) ?? this.phrase;
        const params = { ...this.values, ...this.params, ...markupTokenValues(this.slots.length) };
        const resolved = interpolate(raw, params, currentlyLoadedLocale.get());
        // Into the nodes already there when the translation keeps the markup's shape, so a
        // framework's references to them stay live; rebuilt only when it does not.
        if (applyInPlace(this.host, resolved, (element) => this.slotOf.get(element))) return;
        const nodes = reconstitute(resolved, this.slots, this.host.ownerDocument ?? document, (element, slot) =>
            this.slotOf.set(element, slot)
        );
        this.host.replaceChildren(...nodes);
    }
}

/** A phrase with no text of its own: only placeholders and markup tokens. */
function isOnlyPlaceholders(phrase: string): boolean {
    return !phrase.replace(/\{[a-z][a-z0-9_]*\}/g, '').trim();
}

/**
 * The host's elements in pre-order, the order `encodeRichText` numbers its slots
 * in. A `data-ls-param` element marks a value (VAR-3), and is no slot.
 */
function hostElements(host: Element): Element[] {
    const out: Element[] = [];
    const visit = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
            if (paramElementName(child as unknown as MarkerNode) !== null) continue;
            out.push(child);
            visit(child);
        }
    };
    visit(host);
    return out;
}

export default Phrase;
