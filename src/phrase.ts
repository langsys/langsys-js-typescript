import { interpolate, warnUnmatchedParams } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { encodeRichText, markupTokenValues, reconstitute, type RichSlot } from './richtext.js';
import type { Unsubscriber } from './signal.js';
import { currentlyLoadedLocale, sTranslations } from './stores.js';

/** Attribute marker the `Translate` tokenizer uses to skip a `<Phrase>` subtree. */
export const PHRASE_MARKER_ATTR = 'data-ls-phrase';

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
    params?: Record<string, unknown>;
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
    private params: Record<string, unknown>;
    private phrase = '';
    private slots: RichSlot[] = [];
    private unsubscribers: Unsubscriber[] = [];
    private ready = false;
    /** Sorted params key-set already checked, so value-only updates don't re-warn. */
    private checkedParamKeys: string | null = null;

    constructor(host: HTMLElement, options: PhraseOptions = {}) {
        this.host = host;
        this.category = options.category ?? '';
        this.params = options.params ?? {};

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
    }

    /** Update interpolation params (e.g. a changed count) and re-render. */
    public setParams(params: Record<string, unknown>): void {
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
    }

    private async _init(): Promise<void> {
        if (!this.host || !this.host.childNodes.length) {
            this.ready = true;
            return;
        }

        const { phrase, slots } = encodeRichText(this.host);
        this.phrase = phrase;
        this.slots = slots;
        this._checkParams();

        // Register the phrase (triggers the missing-token POST on a cache miss).
        // We ignore t()'s interpolated return — Phrase renders itself so it can
        // supply the markup-token sentinel values and reconstitute real elements.
        await LangsysApp.Translations.ready();
        LangsysApp.Translations.t(this.phrase, this.category);

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

    private _render(): void {
        if (!this.phrase) return;

        const raw = LangsysApp.Translations.lookup(this.phrase, this.category) ?? this.phrase;
        const params = { ...this.params, ...markupTokenValues(this.slots.length) };
        const resolved = interpolate(raw, params, currentlyLoadedLocale.get());
        const nodes = reconstitute(resolved, this.slots, this.host.ownerDocument ?? document);

        this.host.replaceChildren(...nodes);
    }
}

export default Phrase;
