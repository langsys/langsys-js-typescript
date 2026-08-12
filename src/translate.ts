import {
    generateCustomId,
    isContentBlockKnown,
    registerContentBlock,
    tokenizeElement,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './content-block.js';
import { interpolate, normalizeMarkupPlaceholders, warnUnmatchedParams } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { currentlyLoadedLocale, sTranslations, config as configStore } from './stores.js';
import type { Unsubscriber } from './signal.js';
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
    /** Interpolation params — `{name}`, `{count}`, etc. Same single-brace syntax as `t()`. */
    params?: Record<string, ParamPrimitive>;
}

type iNode = Node & { originalNodeValue?: string | null };
type iElement = HTMLElement & { originalAttributes?: Record<string, string> };

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

    constructor(element: HTMLElement, options: TranslateOptions = {}) {
        this.element = element;
        this.options = { ...options };
        this.custom_id = options.custom_id || '';

        // First pass: tokenize + save + translate.
        void this.tokenizeContent();

        // React to locale changes.
        this.unsubscribers.push(
            currentlyLoadedLocale.subscribe((locale) => {
                if (locale && this.parseComplete) this.translateUpdate(locale);
            }),
        );

        // React to catalog changes too (same pattern as Phrase). A same-locale
        // refetch — refresh(), a token-flush writeback — replaces sTranslations
        // without changing currentlyLoadedLocale's value, so that signal alone
        // never re-renders it.
        this.unsubscribers.push(
            sTranslations.subscribe(() => {
                if (!this.parseComplete) return;
                const locale = currentlyLoadedLocale.get();
                if (!locale) return;
                this.lastTranslatedLocale = ''; // catalog changed — force a re-walk
                this.translateUpdate(locale);
            }),
        );
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

    /** Stop reacting to locale/translation changes. Safe to call multiple times. */
    public destroy() {
        this.unsubscribers.forEach((unsub) => unsub());
        this.unsubscribers = [];
    }

    private translateUpdate(currentLocale: string) {
        if (!this.element?.innerHTML || !this.parseComplete) return;
        if (this.lastTranslatedLocale === currentLocale) return;

        const { category = '' } = this.options;

        if (this.tokens.length === 1) {
            this.renderSingleToken(category);
        } else {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentLocale;
        }
    }

    /**
     * Render a single-token block. The token may live in the catalog as a
     * content block — registered under an explicit `custom_id`, by an earlier
     * SDK version, or seeded server-side — and flat `t()` can't see inside
     * content-block entries, so prefer that entry. Fall back to the flat
     * phrase catalog (`t()`, which also queues the miss for write-key
     * registration).
     */
    private renderSingleToken(category: string): void {
        const token = this.tokens[0];
        const blockTranslation = LangsysApp.Translations.lookupContent(category, this.custom_id, token);
        const resolved = this.applyParams(blockTranslation ?? LangsysApp.Translations.t(token, category));
        // A single-token block may still wrap its text in markup —
        // <translate><p>text</p></translate> is the framework-component shape —
        // so write into the text node instead of flattening the subtree
        // (innerText assignment would destroy the <p> and its styling).
        const textNode = this.findSingleTextNode(this.element);
        if (textNode) textNode.nodeValue = resolved;
        else this.element.innerText = resolved;
    }

    /**
     * The unique non-whitespace text node under `root`, or null when there are
     * zero or several — callers fall back to a flat text render in that case.
     */
    private findSingleTextNode(root: Node): Node | null {
        let found: Node | null = null;
        const walk = (parent: Node): boolean => {
            for (const child of Array.from(parent.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) {
                    if ((child.nodeValue ?? '').trim()) {
                        if (found) return false;
                        found = child;
                    }
                } else if (!walk(child)) {
                    return false;
                }
            }
            return true;
        };
        return walk(root) ? found : null;
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
        const { tokens, content } = tokenizeElement(this.element);
        this.tokens = tokens;
        this.checkParams();

        const { category = '' } = this.options;

        if (this.tokens.length === 1) {
            if (isEmpty(this.custom_id)) {
                this.custom_id = generateCustomId(category, this.tokens);
            }
            this.renderSingleToken(category);
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
        return true;
    }

    private async handleContentBlock(contentBlock: iContentBlock) {
        if (isEmpty(this.custom_id)) {
            this.custom_id = generateCustomId(contentBlock.category, contentBlock.tokens);
        }
        contentBlock.custom_id = this.custom_id;

        // Wait for the first GET /translations to settle before deciding whether
        // to POST — otherwise on a cold cache the lookup misses and we'd POST
        // every CB on every first visit even when the backend already has it.
        await LangsysApp.Translations.ready();

        if (isContentBlockKnown(contentBlock.category, this.custom_id)) {
            // Backend already has this block — translate locally, no POST.
            if (this.tokens.length > 1 && this.element) {
                this.translate(Array.from(this.element.childNodes));
                this.lastTranslatedLocale = currentlyLoadedLocale.get();
            }
            return;
        }

        // Fire-and-forget: registerContentBlock handles its own errors via
        // the logger. We don't await here because the DOM render path below
        // doesn't depend on the POST completing — translations are looked up
        // from sTranslations on every render, which updates reactively when
        // the GET response arrives.
        void registerContentBlock(contentBlock);

        if (this.tokens.length > 1 && this.element) {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentlyLoadedLocale.get();
        }
    }

    private translate(nodes: iNode[]) {
        const currentLocale = currentlyLoadedLocale.get();
        // With params, the base locale still needs a pass — placeholders must
        // be interpolated even when no translation lookup will hit.
        if (
            currentLocale === configStore.baseLocale &&
            (this.lastTranslatedLocale === '' || this.lastTranslatedLocale === configStore.baseLocale) &&
            isEmpty(this.options.params)
        ) {
            return;
        }

        nodes.forEach((node) => {
            if (node?.nodeType === Node.ELEMENT_NODE) {
                const element = node as HTMLElement;
                if (element.getAttribute('translate') === 'no') return;
                // A <Phrase> subtree manages its own rendering — don't recurse.
                if (element.hasAttribute('data-ls-phrase')) return;
                this.translateAttributes(node as iElement);
            }

            if (node?.nodeType !== Node.TEXT_NODE) {
                if (!node?.hasChildNodes()) return;
                this.translate(Array.from(node.childNodes));
                return;
            }

            if (isEmpty(node.nodeValue?.trim())) return;

            if (isEmpty(node.originalNodeValue)) {
                // Snapshot in canonical placeholder form so lookups, replaces,
                // and interpolation all operate on `{key}`.
                node.originalNodeValue = normalizeMarkupPlaceholders(node.nodeValue!);
            }

            const contentToken = node.originalNodeValue?.replace(/\s+/g, ' ').trim();
            if (!contentToken) return;

            const translation = this.getTranslation(contentToken);

            if (translation && contentToken && node.originalNodeValue) {
                // Replacer fn so `$`-patterns in translations/params stay literal.
                const resolved = this.applyParams(translation);
                node.nodeValue = node.originalNodeValue.replace(contentToken, () => resolved);
            } else if (node.originalNodeValue) {
                node.nodeValue = this.applyParams(node.originalNodeValue);
            }
        });
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
        // once tokens exist.
        if (!this.tokens.length) return;

        const { params, category = '' } = this.options;
        const signature = params ? Object.keys(params).sort().join(',') : '';
        if (signature === this.checkedParamKeys) return;
        this.checkedParamKeys = signature;

        warnUnmatchedParams('<Translate>', this.tokens, params, category || undefined);
    }

    /**
     * Interpolate `{name}`-style params into a resolved text, matching `t()`:
     * unknown keys fall through untouched, and the untranslated fallback is
     * interpolated too. No-op when no params were supplied.
     */
    private applyParams(text: string): string {
        const { params } = this.options;
        if (isEmpty(params)) return text;
        return interpolate(text, params!, currentlyLoadedLocale.get());
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
                const originalText = optionEl.originalAttributes['textContent'].trim();
                if (originalText) {
                    const translation = this.getTranslation(originalText);
                    option.textContent = this.applyParams(translation || optionEl.originalAttributes['textContent']);
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

        const originalValue = element.originalAttributes![attr].trim();
        if (!originalValue) return;

        const translation = this.getTranslation(originalValue);
        if (translation) element.setAttribute(attr, this.applyParams(translation));
        else element.setAttribute(attr, this.applyParams(element.originalAttributes![attr]));
    }

}

export default Translate;
