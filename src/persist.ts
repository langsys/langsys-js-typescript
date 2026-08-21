import { createSignal, type Signal } from './signal.js';

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
