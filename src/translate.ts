import {
    generateCustomId,
    isContentBlockKnown,
    isPhraseMarked,
    isTranslationExcluded,
    legacyTokenizeElement,
    registerContentBlock,
    generateLegacyCustomId,
    tokenizeElement,
    TRANSLATABLE_ATTRIBUTES,
    VALUE_TRANSLATABLE_ELEMENTS,
    VALUE_TRANSLATABLE_INPUT_TYPES,
} from './content-block.js';
import { interpolate, normalizeMarkupPlaceholders, warnUnmatchedParams } from './interpolate.js';
import { LangsysApp } from './langsys-app.js';
import { logger } from './logger.js';
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

    /** Stop reacting to locale and catalog changes. Safe to call multiple times. */
    public destroy() {
        this.unsubscribers.forEach((unsub) => unsub());
        this.unsubscribers = [];
    }

    private translateUpdate(currentLocale: string) {
        if (!this.element?.innerHTML || !this.parseComplete) return;
        if (this.lastTranslatedLocale === currentLocale) return;

        const { category = '' } = this.options;

        if (this.usesSingleTextNodeFastPath()) {
            this.renderSingleToken(category);
            this.lastTranslatedLocale = currentLocale;
        } else {
            this.translate(Array.from(this.element.childNodes));
            this.lastTranslatedLocale = currentLocale;
        }
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
        const resolved = this.applyParams(fromBlock ?? LangsysApp.Translations.t(token, category));

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
        return this.tokens.length === 1 && this.findSingleTextNode(this.element) !== null;
    }

    /**
     * The unique non-whitespace text node under `root`, or `null` when there is
     * none or more than one — in which case the caller falls back to a flat
     * text render, since there is no single place to put the result.
     */
    private findSingleTextNode(root: Node): Node | null {
        const TEXT_NODE = 3;
        let found: Node | null = null;
        const walk = (parent: Node): boolean => {
            for (const child of Array.from(parent.childNodes)) {
                if (child.nodeType === TEXT_NODE) {
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

        if (this.usesSingleTextNodeFastPath()) {
            // Derive the id even for a single token: without one there is
            // nothing to look the block up BY, so a single-token block stored
            // in the catalog could never be found and would re-register on
            // every visit.
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
            if (!this.usesSingleTextNodeFastPath() && this.element) {
                this.translate(Array.from(this.element.childNodes));
                this.lastTranslatedLocale = currentlyLoadedLocale.get();
            }
            return;
        }

        // Migration fallback: resolve blocks registered by older SDKs so their
        // translations keep working instead of orphaning. Two things have moved
        // the id, so there are three historical shapes to try:
        //
        //   corrected md5 + corrected tokens  → current (tried above)
        //   corrected md5 + legacy tokens     → registered by 0.6.0–0.6.2
        //   legacy md5    + legacy tokens     → registered before 0.6.0
        //
        // (legacy md5 + corrected tokens never existed — the token fix came
        // after the hash fix.) LOOKUP ONLY: registration below always uses the
        // corrected id, so the legacy-keyed population can only shrink.
        // Skipped for a caller-supplied custom_id, since nothing was derived.
        if (derivedId) {
            const legacyTokens = legacyTokenizeElement(this.element);
            const candidates = [
                generateCustomId(contentBlock.category, legacyTokens),
                generateLegacyCustomId(contentBlock.category, legacyTokens),
            ];
            for (const candidate of candidates) {
                if (candidate === this.custom_id) continue;
                if (!isContentBlockKnown(contentBlock.category, candidate)) continue;
                this.custom_id = candidate;
                if (!this.usesSingleTextNodeFastPath() && this.element) {
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

        // Not `tokens.length > 1`: an attribute-only block has ONE token and
        // still belongs here, and that guard is what would silently skip its
        // render after the routing above sent it down this path.
        if (!this.usesSingleTextNodeFastPath() && this.element) {
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
                if (isTranslationExcluded(element)) return;
                // A <Phrase> subtree manages its own rendering — don't recurse.
                if (isPhraseMarked(element)) return;
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
