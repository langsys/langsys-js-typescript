import {
    generateCustomId,
    isContentBlockKnown,
    registerContentBlock,
    generateLegacyCustomId,
    tokenizeElement,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './content-block.js';
import { interpolate, normalizeMarkupPlaceholders, warnUnmatchedParams } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { currentlyLoadedLocale, config as configStore } from './stores.js';
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
    /**
     * Interpolation params — `{name}`, `{count}`, etc. Same single-brace syntax
     * as `t()`, and what you write in plain DOM. In a framework component's
     * markup write `%name%` / `%count%` instead: Svelte and JSX consume
     * `{name}` at compile time (Vue consumes `{{ name }}`), and `%name%` is
     * normalized back to `{name}` at capture.
     */
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
    private unsubscribeLocale: Unsubscriber | null = null;
    /** Sorted params key-set already checked, so value-only updates don't re-warn. */
    private checkedParamKeys: string | null = null;

    constructor(element: HTMLElement, options: TranslateOptions = {}) {
        this.element = element;
        this.options = { ...options };
        this.custom_id = options.custom_id || '';

        // First pass: tokenize + save + translate.
        void this.tokenizeContent();

        // React to locale changes.
        this.unsubscribeLocale = currentlyLoadedLocale.subscribe((locale) => {
            if (locale && this.parseComplete) this.translateUpdate(locale);
        });
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

    /** Stop reacting to locale changes. Safe to call multiple times. */
    public destroy() {
        if (this.unsubscribeLocale) {
            this.unsubscribeLocale();
            this.unsubscribeLocale = null;
        }
    }

    private translateUpdate(currentLocale: string) {
        if (!this.element?.innerHTML || !this.parseComplete) return;
        if (this.lastTranslatedLocale === currentLocale) return;

        const { category = '' } = this.options;

        if (this.tokens.length === 1) {
            this.element.innerText = this.applyParams(LangsysApp.Translations.t(this.tokens[0], category));
        } else {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentLocale;
        }
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
            this.element.innerText = this.applyParams(LangsysApp.Translations.t(this.tokens[0], category));
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
        const derivedId = isEmpty(this.custom_id);
        if (derivedId) {
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

        // Migration fallback: blocks registered before the 0.6.0 MD5 fix are
        // keyed by the legacy id. Resolve against it so their translations keep
        // working instead of orphaning. LOOKUP ONLY — registration below always
        // uses the corrected id, so the legacy-keyed population never grows.
        // Skipped for a caller-supplied custom_id (nothing was derived) and when
        // the two ids agree (pure-ASCII content, the common case).
        if (derivedId) {
            const legacyId = generateLegacyCustomId(contentBlock.category, contentBlock.tokens);
            if (legacyId !== this.custom_id && isContentBlockKnown(contentBlock.category, legacyId)) {
                this.custom_id = legacyId;
                if (this.tokens.length > 1 && this.element) {
                    this.translate(Array.from(this.element.childNodes));
                    this.lastTranslatedLocale = currentlyLoadedLocale.get();
                }
                return;
            }
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
