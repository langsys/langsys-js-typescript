import {
    generateCustomId,
    isContentBlockKnown,
    registerContentBlock,
    tokenizeElement,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './content-block.js';
import { LangsysApp } from './langsys-app.js';
import { currentlyLoadedLocale, config as configStore } from './stores.js';
import type { Unsubscriber } from './signal.js';
import type { iContentBlock } from './types/content-block.js';
import { isEmpty } from './utils.js';

/** Options for the `Translate` class. Matches the Svelte component's props. */
export interface TranslateOptions {
    /** Optional category under which tokens are registered. Helps translators disambiguate. */
    category?: string;
    /** Optional stable id for the content block. If omitted, we hash category+tokens. */
    custom_id?: string;
    /** Optional human-readable label shown in the Translation Manager. */
    label?: string;
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
            this.element.innerText = LangsysApp.Translations.t(this.tokens[0], category);
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

        const { category = '' } = this.options;

        if (this.tokens.length === 1) {
            this.element.innerText = LangsysApp.Translations.t(this.tokens[0], category);
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
        if (
            currentLocale === configStore.baseLocale &&
            (this.lastTranslatedLocale === '' || this.lastTranslatedLocale === configStore.baseLocale)
        ) {
            return;
        }

        nodes.forEach((node) => {
            if (node?.nodeType === Node.ELEMENT_NODE) {
                const element = node as HTMLElement;
                if (element.getAttribute('translate') === 'no') return;
                this.translateAttributes(node as iElement);
            }

            if (node?.nodeType !== Node.TEXT_NODE) {
                if (!node?.hasChildNodes()) return;
                this.translate(Array.from(node.childNodes));
                return;
            }

            if (isEmpty(node.nodeValue?.trim())) return;

            if (isEmpty(node.originalNodeValue)) {
                node.originalNodeValue = node.nodeValue;
            }

            const contentToken = node.originalNodeValue?.replace(/\s+/g, ' ').trim();
            if (!contentToken) return;

            const translation = this.getTranslation(contentToken);

            if (translation && contentToken && node.originalNodeValue) {
                node.nodeValue = node.originalNodeValue.replace(contentToken, translation);
            } else if (node.originalNodeValue) {
                node.nodeValue = node.originalNodeValue;
            }
        });
    }

    private getTranslation(token: string): string | null {
        if (!token) return null;
        const { category = '' } = this.options;
        return LangsysApp.Translations.lookupContent(category, this.custom_id, token);
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
                    optionEl.originalAttributes['textContent'] = option.textContent || '';
                }
                const originalText = optionEl.originalAttributes['textContent'].trim();
                if (originalText) {
                    const translation = this.getTranslation(originalText);
                    option.textContent = translation || optionEl.originalAttributes['textContent'];
                }
            });
        }
    }

    private translateAttribute(element: iElement, attr: string) {
        const currentValue = element.getAttribute(attr);
        if (!currentValue) return;

        if (element.originalAttributes![attr] === undefined) {
            element.originalAttributes![attr] = currentValue;
        }

        const originalValue = element.originalAttributes![attr].trim();
        if (!originalValue) return;

        const translation = this.getTranslation(originalValue);
        if (translation) element.setAttribute(attr, translation);
        else element.setAttribute(attr, element.originalAttributes![attr]);
    }

}

export default Translate;
