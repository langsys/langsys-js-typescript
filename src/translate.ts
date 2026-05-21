import { LangsysAppAPI } from './api.js';
import { LangsysApp } from './langsys-app.js';
import { logger } from './logger.js';
import { config as configStore, currentlyLoadedLocale, sTranslations } from './stores.js';
import type { Unsubscriber } from './signal.js';
import type { iContentBlock } from './types/content-block.js';
import type { iTranslations } from './types/translations.js';
import { isEmpty, md5 } from './utils.js';

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
 * HTML attributes whose values should be harvested for translation.
 */
const TRANSLATABLE_ATTRIBUTES = [
    'placeholder',
    'alt',
    'title',
    'aria-label',
    'aria-placeholder',
    'data-error',
    'data-error-message',
    'data-validation-message',
    'data-invalid-message',
    'data-required-message',
    'data-pattern-message',
];

const VALUE_TRANSLATABLE_ELEMENTS = ['button'];
const VALUE_TRANSLATABLE_INPUT_TYPES = ['submit', 'button'];

/**
 * Semantic CSS properties captured on cloned content for the Translation Manager
 * so translators see the content styled the way end-users do.
 */
const SEMANTIC_STYLE_PROPERTIES = [
    'font-size', 'font-weight', 'font-style', 'font-variant', 'line-height',
    'letter-spacing', 'word-spacing', 'text-align', 'text-decoration',
    'text-transform', 'text-indent', 'text-shadow', 'white-space', '-webkit-font-smoothing',
    'color', 'background-color', 'background-image', 'background-position',
    'background-size', 'background-repeat',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'border-color', 'border-width', 'border-style',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'box-shadow', 'opacity', 'filter',
    'display', 'visibility', 'list-style', 'list-style-type',
    'cursor',
];

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
    private contentClone: HTMLElement | null = null;
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
            this.element.innerText = LangsysApp.Translations.t(category, this.tokens[0]);
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
        this.contentClone = this.element.cloneNode(true) as HTMLElement;
        const nodes = Array.from(this.contentClone.childNodes || []);
        this.tokenize(nodes);

        const { category = '' } = this.options;

        if (this.tokens.length === 1) {
            this.element.innerText = LangsysApp.Translations.t(category, this.tokens[0]);
        } else {
            const contentBlock: iContentBlock = {
                custom_id: '',
                category,
                label: this.options.label,
                content: this.contentClone!.outerHTML,
                tokens: this.tokens,
            };
            await this.handleContentBlock(contentBlock);
        }

        this.parseComplete = true;
        this.isTokenizing = false;
        return true;
    }

    private async handleContentBlock(contentBlock: iContentBlock) {
        if (isEmpty(this.custom_id)) this.custom_id = this.generateCustomId(contentBlock);
        contentBlock.custom_id = this.custom_id;

        // Wait for the first GET /translations to settle before deciding whether
        // to POST — otherwise on a cold cache the lookup misses and we'd POST
        // every CB on every first visit even when the backend already has it.
        await LangsysApp.Translations.ready();

        const lookupCat = contentBlock.category || '__uncategorized__';
        const cats = sTranslations.get();
        const cbData = cats[lookupCat]?.[this.custom_id];
        const alreadyKnown = typeof cbData === 'object' && cbData !== null;

        if (alreadyKnown) {
            // Backend already has this block — translate locally, no POST.
            if (this.tokens.length > 1 && this.element) {
                this.translate(Array.from(this.element.childNodes));
                this.lastTranslatedLocale = currentlyLoadedLocale.get();
            }
            return;
        }

        if (configStore.key_type === 'write') {
            LangsysAppAPI.post('projects/[projectid]/content-blocks', contentBlock as unknown as Record<string, unknown>)
                .then((response) => {
                    if (!response.status) {
                        logger.error('Could not save content block', response.errors);
                    } else {
                        // Mirror the standalone-phrase path: stamp the new key
                        // into sTranslations so subsequent mounts in this session
                        // (and after reload, since sTranslations is persisted)
                        // see it as already-known and skip the POST.
                        sTranslations.update((current) => {
                            if (!current[lookupCat]) {
                                current[lookupCat] = {
                                    __category__: lookupCat,
                                    __symbol__: lookupCat,
                                } as iTranslations;
                            }
                            (current[lookupCat] as unknown as Record<string, unknown>)[this.custom_id] = {};
                            return { ...current };
                        });
                    }
                })
                .catch((err) => logger.error('Could not save content block', err));
        } else if (configStore.debug) {
            logger.log(`Skipping content block save (API key is ${configStore.key_type || 'unknown'})`);
        }

        if (this.tokens.length > 1 && this.element) {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentlyLoadedLocale.get();
        }
    }

    private tokenize(nodes: iNode[], indices: number[] = []) {
        nodes.forEach((node, index) => {
            if (node?.nodeType === Node.ELEMENT_NODE) {
                const element = node as HTMLElement;
                if (element.getAttribute('translate') === 'no') return;
            }

            if (node?.hasChildNodes()) {
                this.applyStylesToNode(node as HTMLElement, [...indices, index]);
            }

            if (node?.nodeType === Node.ELEMENT_NODE) {
                this.tokenizeAttributes(node as HTMLElement);
            }

            const contentToken = node.nodeValue?.replace(/\s+/g, ' ').trim();
            if (node?.nodeType === Node.TEXT_NODE && contentToken) {
                this.tokens.push(contentToken);
                return;
            }

            if (!node?.hasChildNodes()) return;
            this.tokenize(Array.from(node.childNodes), [...indices, index]);
        });
    }

    private tokenizeAttributes(element: HTMLElement) {
        const tagName = element.tagName.toLowerCase();

        if (tagName === 'img') {
            const img = element as HTMLImageElement;
            if (img.src) element.setAttribute('src', img.src);
        }

        for (const attr of TRANSLATABLE_ATTRIBUTES) {
            const value = element.getAttribute(attr)?.trim();
            if (value) this.tokens.push(value);
        }

        if (VALUE_TRANSLATABLE_ELEMENTS.includes(tagName)) {
            const value = element.getAttribute('value')?.trim();
            if (value) this.tokens.push(value);
        }

        if (tagName === 'input') {
            const inputType = element.getAttribute('type')?.toLowerCase();
            if (inputType && VALUE_TRANSLATABLE_INPUT_TYPES.includes(inputType)) {
                const value = element.getAttribute('value')?.trim();
                if (value) this.tokens.push(value);
            }
        }

        if (tagName === 'select') {
            const options = element.querySelectorAll('option');
            options.forEach((option) => {
                const optionText = option.textContent?.trim();
                if (optionText) this.tokens.push(optionText);
            });
        }
    }

    private findNode(nodes: iNode[], indices: number[]): Element | undefined {
        let currentNode: Node | undefined = nodes[indices[0]];
        for (let i = 1; i < indices.length; i++) {
            if (!currentNode || !currentNode.hasChildNodes()) return undefined;
            currentNode = Array.from(currentNode.childNodes)[indices[i]];
        }
        return currentNode as Element;
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

    private generateCustomId(contentBlock: iContentBlock): string {
        // JSON-stringify the [category, tokens] tuple so each token is
        // unambiguously delimited. The previous `tokens.join('-')` was
        // collision-prone for any token containing a hyphen (e.g. `e-mail`,
        // `read-only`): `['e-mail', 'address']` and `['e', 'mail-address']`
        // both joined to the same string. Note this changes the hash of
        // every existing content block — see CHANGELOG for migration.
        return md5(JSON.stringify([contentBlock.category, contentBlock.tokens]));
    }

    private applyStylesToNode(node: HTMLElement, indices: number[]) {
        if (!this.element || typeof window === 'undefined') return;
        const domNode = this.findNode(Array.from(this.element.childNodes), indices);
        if (!domNode) return;

        const tagName = domNode.tagName.toLowerCase();
        const reference = document.createElement(tagName);
        reference.style.visibility = 'hidden';
        reference.style.position = 'absolute';
        document.body.appendChild(reference);

        const computed = window.getComputedStyle(domNode);
        const defaults = window.getComputedStyle(reference);

        for (const prop of SEMANTIC_STYLE_PROPERTIES) {
            const value = computed.getPropertyValue(prop);
            const defaultValue = defaults.getPropertyValue(prop);
            if (value && value !== defaultValue) {
                node.style.setProperty(prop, value);
            }
        }

        document.body.removeChild(reference);
        node.removeAttribute('class');
    }
}

export default Translate;
