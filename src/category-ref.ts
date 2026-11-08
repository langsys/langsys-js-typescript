/**
 * Moving content between categories (spec MOVE-1..MOVE-4).
 *
 * Category is part of a phrase's identity, so a `t()` call or block moved into a
 * better category registers as new content, and the API would translate it, and
 * charge for it, again. Naming the category the content was registered under
 * before lets the API copy the old item's translations instead and retire it.
 *
 * `t()`'s second argument is a category when it is a string and params when it is
 * an object, so a move cannot be an options object there without being told apart
 * from params by its keys, which a placeholder named `category` would defeat. It
 * travels in the CATEGORY position instead, as a value `inCategory()` brands:
 *
 *     t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }))
 *
 * The brand is a registry symbol, so a ref made by one copy of the package is
 * recognised by another (a CJS and an ESM copy in one app).
 */

const CATEGORY_REF: unique symbol = Symbol.for('langsys.category');

/** A category, and the category its content was registered under before. Made by `inCategory()`. */
export interface CategoryRef {
    readonly [CATEGORY_REF]: true;
    readonly category: string;
    /** `''` names "no category"; absent names no move (MOVE-1). */
    readonly previousCategory?: string;
}

export interface CategoryMoveOptions {
    /**
     * The category this content was registered under before (MOVE-1). `''` says it
     * had none; `undefined` or `null` says it did not move. A value equal to the
     * category is no move either.
     */
    previousCategory?: string | null;
}

/**
 * A category for `t()`'s category argument that names where the content came from
 * (MOVE-1). It never enters `custom_id`, catalog keys or deduplication (MOVE-2),
 * travels only on the registration a miss triggers (MOVE-3), and until the catalog
 * holds the item under `category`, the previous category's entry renders (MOVE-4).
 * Once the catalog has it, the option has no effect and can be deleted.
 */
export function inCategory(category: string, options: CategoryMoveOptions = {}): CategoryRef {
    const previousCategory = normalizePreviousCategory(category, options.previousCategory);
    const ref: Record<PropertyKey, unknown> = { category };
    if (previousCategory !== undefined) ref.previousCategory = previousCategory;
    Object.defineProperty(ref, CATEGORY_REF, { value: true, enumerable: false });
    return Object.freeze(ref) as unknown as CategoryRef;
}

export function isCategoryRef(value: unknown): value is CategoryRef {
    return typeof value === 'object' && value !== null && (value as Record<PropertyKey, unknown>)[CATEGORY_REF] === true;
}

/**
 * The previous category as it travels: `undefined` for no move — absent, `null`,
 * or equal to the current category — and the string otherwise, `''` included.
 */
export function normalizePreviousCategory(category: string, previous: string | null | undefined): string | undefined {
    if (previous === undefined || previous === null) return undefined;
    if (typeof previous !== 'string') return undefined;
    return previous === (category ?? '') ? undefined : previous;
}

/** A category argument for `t()`: the bare string when nothing moved, a ref otherwise. */
export function categoryArg(category: string, previousCategory: string | null | undefined): string | CategoryRef {
    const previous = normalizePreviousCategory(category, previousCategory);
    return previous === undefined ? category : inCategory(category, { previousCategory: previous });
}

/** The `previous_category` member of a registration item, or nothing (MOVE-1). */
export function previousCategoryField(previous: string | undefined): { previous_category?: string } {
    return previous === undefined ? {} : { previous_category: previous };
}
