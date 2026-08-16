/**
 * Langsys SDK — framework-agnostic TypeScript
 *
 * Realtime continuous translations with automatic token discovery for any
 * web app. The public translation surface is `t(phrase, category?, params?)`
 * — the phrase itself is the lookup key (and the source-language default).
 * Frameworks subscribe to `tSignal` for reactive re-renders.
 */

// Public singletons and classes
export { LangsysApp } from './langsys-app.js';
export { Translations } from './translations.js';
export { Translate, type TranslateOptions } from './translate.js';
export { Phrase, PHRASE_MARKER_ATTR, type PhraseOptions } from './phrase.js';
export {
    encodeRichText,
    reconstitute,
    markupTokenValues,
    stripSentinels,
    type RichSlot,
    type EncodedRichText,
} from './richtext.js';
export { LangsysAppAPI } from './api.js';

// Content-block helpers (framework-agnostic — for React/Vue/Angular/other
// wrappers that own their own DOM rendering and only need the registration
// + dedup primitives, not the Svelte/vanilla in-place DOM mutator).
export {
    generateCustomId,
    generateLegacyCustomId,
    isContentBlockKnown,
    isPhraseMarked,
    isTranslationExcluded,
    legacyTokenizeElement,
    PHRASE_MARKER_ATTRS,
    registerContentBlock,
    tokenizeElement,
} from './content-block.js';

// Reactive primitives
export { createSignal, getValue, type Signal, type Subscriber, type Unsubscriber, type Updater } from './signal.js';
export { persist } from './persist.js';

// Stores (advanced usage — direct subscription to translations / locale)
export { sTranslations, currentlyLoadedLocale } from './stores.js';

// Logger
export { Logger, logger } from './logger.js';

// Utility exports
export { md5, md5Legacy, isEmpty } from './utils.js';
export { findUnusedParamKeys, interpolate, isICU, normalizeMarkupPlaceholders } from './interpolate.js';
export { canonicalizeLocale } from './locale.js';

// Type re-exports
export type { ResponseObject as iLangsysResponse } from './types/api.js';
export type { iLangsysConfig, iLangsysInitConfig, LocaleSource } from './types/config.js';
export type { iContentBlock } from './types/content-block.js';
export type { iCountry, iCountryDialCode, iCountryList } from './types/countries.js';
export type { iCurrency, iCurrencyList } from './types/currencies.js';
export type { iLanguageName, iLocaleData, iLocaleDefault, iLocaleFlat } from './types/locales.js';
export type { iProject } from './types/project.js';
export type {
    ExtractParamKeys,
    ParamPrimitive,
    ParamsFor,
    TArgs,
    TFunction,
    TranslationParams,
} from './types/translation-fn.js';
export type { iCategories, iTranslations } from './types/translations.js';

// Convenience exports — `t` is a stable function that delegates to the
// LangsysApp singleton (reads fresh state on every call). `tSignal` is the
// reactive primitive frameworks bind to.
import { LangsysApp as _LangsysApp } from './langsys-app.js';
import type { TFunction } from './types/translation-fn.js';

export const t: TFunction = ((phrase: string, ...rest: unknown[]): string => {
    // Forward all args verbatim; the underlying TFunction implementation
    // handles the (phrase) / (phrase, params) / (phrase, category) /
    // (phrase, category, params) overload discrimination at runtime.
    return (_LangsysApp.Translations.t as (...a: unknown[]) => string)(phrase, ...rest);
}) as TFunction;

export const tSignal = _LangsysApp.Translations.tSignal;
