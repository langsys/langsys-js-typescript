import { createSignal, type Signal } from './signal.js';
import { structuredCloneShim } from './utils.js';

/**
 * Minimal synchronous storage contract for `persist` — structurally a subset of
 * the DOM `Storage` interface, so `localStorage` satisfies it as-is.
 *
 * Synchronous on purpose: `persist` seeds its signal during module
 * initialization, so an async backend could not be read in time. React Native
 * apps inject a synchronous adapter (MMKV, or an in-memory mirror of
 * AsyncStorage hydrated at startup) via `setPersistStorage`.
 */
export interface PersistStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    /** Optional. Used to drop superseded keys; absent on minimal adapters. */
    removeItem?(key: string): void;
}

interface PersistEntry {
    hydrate: (storage: PersistStorage) => void;
}

/** Every signal `persist` has created, so a late `setPersistStorage` can hydrate them. */
const registry: PersistEntry[] = [];

let injectedStorage: PersistStorage | null = null;

/**
 * Inject the storage backend used by every `persist` signal — those created
 * afterwards AND those that already exist.
 *
 * Re-hydrating the existing ones is the point, not a nicety: the catalog store
 * is built at module load, long before a React Native app can hand us MMKV, so
 * an injection that only applied going forward would apply to none of the
 * signals anyone cares about.
 *
 * Pass `null` to drop the injection and return to auto-detection.
 */
export function setPersistStorage(storage: PersistStorage | null): void {
    injectedStorage = storage;
    if (!storage) {
        // Re-probe on the next access. Auto-detection is memoized, and a caller
        // returning to it has usually changed the environment underneath us.
        browserStorage = undefined;
        return;
    }
    for (const entry of registry) entry.hydrate(storage);
}

/**
 * Create a Signal whose value is persisted to storage when one is available: an
 * injected `PersistStorage` first, else `localStorage`. Falls back to in-memory
 * behaviour during SSR, or when storage is unavailable or quota-exceeded.
 * Stored value is JSON-encoded.
 *
 * `legacyKey` is READ but never written, so a renamed key migrates its cache on
 * first load instead of silently dropping it. A host app that downgrades the
 * SDK still finds its old value where it left it.
 *
 * DO NOT persist `writeEnabled`, `autoDiscovery`, or any other session
 * capability. "Cache it like translations for a faster warm start" is the
 * obvious next optimization and it is wrong twice over:
 *
 *  1. A persisted value is restored SYNCHRONOUSLY at module init, so the client
 *     would mount with a concrete capability while the server rendered from
 *     `undefined` — a hydration mismatch on every consumer, not just the ones
 *     that resolve auth before first render.
 *  2. Write capability is per-session and IP-dependent: the same key answers
 *     differently from different networks, and a grant makes it per-user.
 *     Persisting it caches one session's answer across later sessions on a
 *     shared device — the same unsoundness as caching it on an SSR singleton.
 *
 * Translations are safe to persist because they are project-scoped content, not
 * a permission decision. Capability is re-derived from the server every time.
 */
export function persist<T>(key: string, initial: T, legacyKey?: string): Signal<T> {
    const storage = activeStorage();
    let seed = initial;

    if (storage) {
        const stored = readStored(storage, key, legacyKey);
        if (stored !== undefined) seed = stored as T;
    }

    const signal = createSignal<T>(seed);

    // Resolved per write rather than captured: a signal created before
    // `setPersistStorage` must still write to the injected backend afterwards.
    signal.subscribe((value) => {
        const target = activeStorage();
        if (!target) return;
        try {
            target.setItem(key, JSON.stringify(value));
        } catch {
            // Quota / serialization failure — keep going; in-memory stays authoritative.
        }
    });

    registry.push({
        hydrate: (target) => {
            const stored = readStored(target, key, legacyKey);
            if (stored !== undefined) signal.set(stored as T);
        },
    });

    return signal;
}

export interface PersistScoped<T> {
    signal: Signal<T>;
    scope: (scope: string | null) => void;
    /**
     * Set the value and name whose it is, in `owns`'s terms. It is persisted
     * only while the cache is scoped to a scope that owner owns, now or once
     * `scope()` points there, never under another scope's key.
     */
    setOwned: (value: T, owner: string) => void;
    /**
     * Name whose the value already held is, after a plain `set` put it there.
     * When the owner does not own the current scope, a plain write saved under
     * it since the value was last labelled is undone. With no plain `set` since
     * the value was last labelled, it does nothing: the claim is about another value.
     */
    claim: (owner: string) => void;
    /** Change the value in place, keeping its label: an owner's own edit, never undone by `claim`. */
    edit: (change: (value: T) => T) => void;
}

/**
 * A persisted signal whose storage key is not known at module-init time.
 *
 * `persist` reads its key immediately, which is wrong for anything scoped by
 * identity the SDK does not have yet. The translation catalog is keyed by
 * project AND locale (CACHE-1), and neither exists until `init()` has run — so
 * reading at module load means restoring *some* catalog and serving it before
 * anyone can tell whether it belongs to this project or this language.
 *
 * This variant touches storage only once `scope()` supplies the identity:
 *
 *   - Before the first `scope()`: nothing is read and nothing is written. The
 *     signal holds whatever it was created with, so an SSR handoff that seeded
 *     it is preserved.
 *   - `scope(s)` with data stored under `s`: adopt it.
 *   - `scope(s)` with nothing stored, and a PREVIOUS scope was set: reset to
 *     `initial`. Leaving the old scope's value in place is the bug — it is how
 *     project A's catalog gets served to project B. The reset is not written:
 *     `initial` is no catalog, and stored under `s` it would be read back as
 *     that scope's catalog after a fetch for it failed or was superseded
 *     (CACHE-2). Only a value set afterwards is persisted.
 *   - `scope(s)` with nothing stored and no previous scope: leave the signal
 *     alone, so an SSR-seeded catalog survives.
 *   - `scope(null)`: stop persisting.
 *
 * A writer that knows whose value it sets says so with `setOwned`, and a
 * labelled value is persisted only under a scope its owner owns (`owns`).
 * A fetched catalog is owned by its project and locale, and a seed or snapshot
 * by its bare locale, since one can arrive before `init()` names the project: a seed or a fetch published while the cache
 * is scoped to another locale renders, but is never saved as that locale's
 * catalog, and scoping to its own locale later keeps and saves it.
 */
export function persistScoped<T>(
    keyPrefix: string,
    initial: T,
    supersedes: string[] = [],
    owns: (owner: string, scope: string) => boolean = (owner, scope) => owner === scope,
    qualify: (owner: string, scope: string) => string = (owner) => owner
): PersistScoped<T> {
    const signal = createSignal<T>(initial);
    let currentKey: string | null = null;
    let currentScope: string | null = null;
    // Whose value the signal holds, as `setOwned` named it: `undefined` when no
    // writer said. A labelled value is persisted only under a scope that owner
    // owns, so a catalog published for one locale while the cache is scoped to
    // another is kept in memory and never saved as that other locale's. An
    // unlabelled `set` edits the value in place (a flush marking keys known) and
    // keeps the label; only `setOwned`, adopting a stored copy, or a reset change it.
    let owner: string | undefined;
    // Once a value sits under a scope its owner owns, it is that scope's, and
    // only that scope's: a seed labelled with a bare locale owns every
    // project's key for the locale, so left broad it would be kept, and saved
    // over the stored catalog, when a re-init scopes another project's.
    // A label given before any scope existed (a seed's bare locale) takes the
    // rest of its identity from the first scope it meets, owned or not: the seed
    // is this page's, and the page's project is the scope's. Left bare, it would
    // own every project's key for its locale after a re-init.
    const narrowOwner = (): void => {
        if (owner === undefined || currentScope === null) return;
        owner = qualify(owner, currentScope);
        if (owns(owner, currentScope)) owner = currentScope;
    };
    const ownsCurrent = (): boolean => owner === undefined || (currentScope !== null && owns(owner, currentScope));
    let everScoped = false;
    // Did somebody write to this signal BEFORE any scope existed? That is the
    // SSR handoff: `init()` seeds the catalog from the server payload, and only
    // then does `change()` scope the cache. Such a value is authoritative — it
    // came from this request, for this locale — and must beat anything stored.
    let seededBeforeScope = false;
    let emissions = 0;
    // Set while `scope()` resets the signal, so the reset value is not persisted.
    let resetting = false;
    // Set while `setOwned` publishes or `scope()` adopts a stored copy, so the
    // write is known to be labelled.
    let labelling = false;
    // Set while `edit` writes: the owner's own change to its value, which keeps
    // the label and is never undone.
    let editing = false;
    // Has a plain `set`, from outside this cache's writers, put a value here
    // since it was last labelled? Only then can `claim` say whose it is. A
    // claim with no plain write behind it is about some other catalog (a
    // superseded fetch's locale, landing after the next catalog was published
    // or adopted) and must not relabel, or undo, the one held.
    let plainSinceLabel = false;
    // What the current key held before the first unlabelled write to it since
    // the value was last labelled. A plain `set` cannot say whose value it is, so
    // it is saved as an edit of the current one; if `claim` then names another
    // owner, the write was not this scope's, and the key gets back what it held.
    let undo: { key: string; prior: string | null } | null = null;

    signal.subscribe((value) => {
        emissions += 1;
        // `subscribe` fires immediately with the current value, so emission 1
        // is creation, not a write.
        if (!everScoped && emissions > 1) seededBeforeScope = true;
        const plain = emissions > 1 && !labelling && !editing && !resetting;
        if (plain) plainSinceLabel = true;
        if (labelling || resetting) plainSinceLabel = false;
        if (!currentKey || resetting || !ownsCurrent()) return;
        const target = activeStorage();
        if (!target) return;
        try {
            if (labelling) undo = null;
            else if (plain && undo?.key !== currentKey) undo = { key: currentKey, prior: target.getItem(currentKey) };
            target.setItem(currentKey, JSON.stringify(value));
        } catch {
            // Quota / serialization failure — in-memory stays authoritative.
        }
    });

    const scope = (next: string | null): void => {
        const key = next === null ? null : `${keyPrefix}:${next}`;
        if (key === currentKey) return;

        const storage = activeStorage();
        const stored = key && storage ? readStored(storage, key) : undefined;
        const hadScope = everScoped;

        currentKey = key;
        currentScope = next;
        undo = null;
        if (key !== null) everScoped = true;
        narrowOwner();

        // An SSR handoff outranks the store on the FIRST scoping, whether or
        // not something is stored. Adopting the stored copy here was a
        // regression: the server just rendered this page with a fresh catalog,
        // and `markLoaded` primes the 60s cache-hit so no corrective fetch
        // fires — so a returning visitor to an SSR app would be served last
        // session's strings for the whole session. Persist the fresh value
        // instead, so the next load starts from it.
        // The signal already holds this scope's value, labelled by its writer
        // (a seed or fetch for this locale, published while the cache was
        // scoped elsewhere). It is newer than anything stored, so keep it and
        // save it here rather than adopting a stale copy or resetting it away.
        if (key !== null && owner !== undefined && owns(owner, next as string)) {
            const target = activeStorage();
            if (target) {
                try {
                    target.setItem(key, JSON.stringify(signal.get()));
                } catch {
                    // Quota — in-memory stays authoritative.
                }
            }
            return;
        }

        // A seed for ANOTHER locale still outranks the store in memory (it is
        // what this page was handed), but it is not this scope's catalog, so it
        // is not saved under this scope's key.
        if (!hadScope && seededBeforeScope && key !== null) {
            if (!ownsCurrent()) return;
            const target = activeStorage();
            if (target) {
                try {
                    if (owner === undefined) undo = { key, prior: target.getItem(key) };
                    target.setItem(key, JSON.stringify(signal.get()));
                } catch {
                    // Quota — in-memory stays authoritative.
                }
            }
            return;
        }

        if (stored !== undefined) {
            owner = next as string;
            labelling = true;
            try {
                signal.set(stored as T);
            } finally {
                labelling = false;
            }
            return;
        }
        // Nothing stored for the new scope. Clear only if we are LEAVING a
        // scope — otherwise this is the first scoping and there is nothing to
        // discard.
        if (hadScope && key !== null) {
            owner = undefined;
            resetting = true;
            try {
                signal.set(structuredCloneShim(initial));
            } finally {
                resetting = false;
            }
        }
    };

    const setOwned = (value: T, valueOwner: string): void => {
        owner = valueOwner;
        narrowOwner();
        labelling = true;
        try {
            signal.set(value);
        } finally {
            labelling = false;
        }
    };

    const edit = (change: (value: T) => T): void => {
        editing = true;
        try {
            signal.update(change);
        } finally {
            editing = false;
        }
    };

    const claim = (valueOwner: string): void => {
        if (!plainSinceLabel) return;
        plainSinceLabel = false;
        owner = valueOwner;
        narrowOwner();
        const pending = undo;
        undo = null;
        if (ownsCurrent() || !pending || pending.key !== currentKey) return;
        const target = activeStorage();
        if (!target) return;
        try {
            if (pending.prior !== null) target.setItem(pending.key, pending.prior);
            else target.removeItem?.(pending.key);
        } catch {
            // Unwritable storage — nothing to restore.
        }
    };

    // Drop the unscoped keys this replaces, once, when identity first arrives.
    // They can never be read again, and a stale catalog left in localStorage
    // forever is the kind of thing nobody goes looking for.
    if (supersedes.length) {
        const drop = () => {
            const storage = activeStorage();
            if (!storage?.removeItem) return;
            for (const k of supersedes) {
                try {
                    if (storage.getItem(k) !== null) storage.removeItem(k);
                } catch {
                    // Unreadable storage — nothing to clean.
                }
            }
        };
        const originalScope = scope;
        return {
            signal,
            setOwned,
            edit,
            claim,
            scope: (next) => {
                originalScope(next);
                if (next !== null) drop();
            },
        };
    }

    return { signal, scope, setOwned, edit, claim };
}

/** Current key first, then the legacy one. `undefined` means "nothing usable stored". */
function readStored(storage: PersistStorage, key: string, legacyKey?: string): unknown {
    for (const candidate of legacyKey ? [key, legacyKey] : [key]) {
        try {
            const raw = storage.getItem(candidate);
            if (raw !== null) return JSON.parse(raw);
        } catch {
            // Corrupt or unreadable — try the next candidate, else fall through
            // to the caller's initial value.
        }
    }
    return undefined;
}

function activeStorage(): PersistStorage | null {
    return injectedStorage ?? getSafeStorage();
}

/** `undefined` = not probed yet; `null` = probed and unusable. */
let browserStorage: Storage | null | undefined;

function getSafeStorage(): Storage | null {
    // Memoized because this now runs on every persisted write rather than once
    // at creation.
    if (browserStorage !== undefined) return browserStorage;

    // React Native defines `window` (an alias of `global`) but not
    // `window.localStorage`, so the PROBE below — not the typeof check — is what
    // routes RN to in-memory, or to an injected PersistStorage.
    if (typeof window === 'undefined') return (browserStorage = null);
    try {
        const s = window.localStorage;
        // Some browsers throw on access in private-mode iframes.
        s.getItem('__langsys_probe__');
        return (browserStorage = s ?? null);
    } catch {
        return (browserStorage = null);
    }
}
