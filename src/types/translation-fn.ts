/**
 * Translation function type machinery.
 *
 * The big trick here is `ExtractParamKeys` — a recursive template-literal
 * type that pulls placeholder names out of a phrase at compile time, so
 * `t('Hello, {name}!', { name: 'Sarah' })` is type-checked: passing
 * an object without `name`, or with a key not in the phrase, is a TS error.
 */

/** Allowed value types for interpolation. Mirrors what ICU MessageFormat will accept. */
export type ParamPrimitive = string | number | Date | boolean;

/**
 * Pull placeholder names out of a phrase.
 * @example
 *   ExtractParamKeys<"Hello, {name}!">        // "name"
 *   ExtractParamKeys<"{first} and {last}">    // "first" | "last"
 *   ExtractParamKeys<"no placeholders here">  // never
 */
export type ExtractParamKeys<S extends string> = S extends `${string}{${infer K}}${infer Rest}`
    ? K | ExtractParamKeys<Rest>
    : never;

/** Build the params object type required for a given phrase. */
export type ParamsFor<S extends string> = {
    [K in ExtractParamKeys<S>]: ParamPrimitive;
};

/**
 * Rest-tuple for the optional params argument.
 * Empty when the phrase has no placeholders → 3rd arg is forbidden.
 * Required tuple when the phrase has placeholders → 3rd arg must be passed.
 */
export type TArgs<P extends string> = [ExtractParamKeys<P>] extends [never]
    ? []
    : [params: ParamsFor<P>];

/** Loose params type — used inside generic stores where the phrase isn't a known literal. */
export type TranslationParams = Record<string, ParamPrimitive>;

/**
 * The translation function signature.
 *
 *   t('Save')                                     // no category, no params
 *   t('Save', 'UI')                               // categorized
 *   t('Hello, {name}!', { name: 'X' })            // no category, with params
 *   t('Hello, {name}!', 'Greetings', { name: 'X' }) // category + params
 *
 * Two overloads discriminate on the type at position 2 (string → category,
 * object → params). `category` is required for the second overload —
 * pass any non-empty string. There is no "null category" wire concept:
 * absent category means absent.
 */
export interface TFunction {
    <P extends string>(phrase: P, ...args: TArgs<P>): string;
    <P extends string>(phrase: P, category: string, ...args: TArgs<P>): string;
}
