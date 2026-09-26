import { _followRequestScope, pageCatalog } from './stores.js';
import type { iContentBlock } from './types/content-block.js';
import type { iCategories } from './types/translations.js';

/**
 * Which request scope, if any, the current code runs in (spec SRV-7).
 *
 * Kept apart from `request-scope.ts` so the modules that read the catalog —
 * `t()`, the content-block lookups, registration — can ask "which catalog?"
 * without importing the scope's implementation, which imports them.
 */

/** What the core needs from an active scope. */
export interface ActiveScope {
    readonly locale: string;
    readonly catalog: iCategories;
    /** `t()` inside the scope: reads the scope's catalog and records the scope's misses. */
    t(phrase: string, ...rest: unknown[]): string;
    /** Hold a content block for the scope's flush after the response. */
    recordBlock(block: iContentBlock): void;
}

/** The ambient-context shape `AsyncLocalStorage` has, so the core never imports `node:async_hooks`. */
export interface ScopeStorage {
    getStore(): unknown;
    run<R>(store: unknown, fn: () => R): R;
    /** Makes a store current for the rest of the async context; needed only by `scope.enter()`. */
    enterWith?(store: unknown): void;
}

let storage: ScopeStorage | null = null;
/** Without a storage, `run` nests synchronously: only code that finishes inside `fn` sees the scope. */
const stack: ActiveScope[] = [];

/**
 * Hand the core an `AsyncLocalStorage` (or anything of its shape), so a scope
 * entered with `scope.run()` stays current across `await` inside the render.
 * Pass `null` to go back to synchronous nesting.
 */
export function setRequestScopeStorage(value: ScopeStorage | null): void {
    storage = value;
}

/** The scope the current code runs in, or undefined outside every scope. */
export function activeScope(): ActiveScope | undefined {
    const stored = storage?.getStore() as ActiveScope | undefined;
    return stored ?? stack[stack.length - 1];
}

/**
 * Make `scope` current for the rest of the current async context, for a host
 * that cannot wrap its render in a function (a Nuxt server plugin, a Nitro
 * request hook). Needs a storage with `enterWith`: there is no synchronous
 * fallback, since the context outlives any stack frame.
 */
export function enterScope(scope: ActiveScope): void {
    if (!storage?.enterWith) {
        throw new Error(
            'scope.enter() needs an AsyncLocalStorage: call setRequestScopeStorage(new AsyncLocalStorage()) once at startup, or wrap the render in scope.run().'
        );
    }
    storage.enterWith(scope);
}

/** Run `fn` with `scope` current, and return what `fn` returns: a promise stays a promise. */
export function runInScope<R>(scope: ActiveScope, fn: () => R): R {
    if (storage) return storage.run(scope, fn);
    stack.push(scope);
    try {
        return fn();
    } finally {
        stack.pop();
    }
}

/** The catalog the current code reads: its scope's, or the page's. */
export function activeCatalog(): iCategories {
    return activeScope()?.catalog ?? pageCatalog();
}

// `sTranslations.get()` and `currentlyLoadedLocale.get()` follow the scope too.
_followRequestScope(() => activeScope());
