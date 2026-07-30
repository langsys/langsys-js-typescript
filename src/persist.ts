import { createSignal, type Signal } from './signal.js';

/**
 * Minimal synchronous storage contract for `persist` — structurally a subset
 * of the DOM `Storage` interface, so `localStorage` satisfies it as-is. React
 * Native apps can inject a synchronous adapter (e.g. MMKV, or a hydrated
 * in-memory mirror of AsyncStorage) via `setPersistStorage`.
 */
export interface PersistStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

interface PersistEntry {
    key: string;
    legacyKey?: string;
    hydrate: (storage: PersistStorage) => void;
}

/** Signals created by `persist`, so a late `setPersistStorage` can hydrate them. */
const registry: PersistEntry[] = [];

let injectedStorage: PersistStorage | null = null;

/**
 * Inject the storage backend used by every `persist` signal — past and future.
 * Environments without a usable `localStorage` (React Native, workers) call
 * this once at startup; already-created signals (the catalog store is built at
 * module load) are re-hydrated from the injected storage immediately, and all
 * subsequent writes go to it. Pass `null` to fall back to auto-detection.
 */
export function setPersistStorage(storage: PersistStorage | null): void {
    injectedStorage = storage;
    if (!storage) return;
    for (const entry of registry) entry.hydrate(storage);
}

/**
 * Create a Signal whose value is persisted to storage (when available):
 * an injected `PersistStorage` first, else `localStorage`. Falls back to
 * in-memory behavior during SSR or when storage is unavailable or
 * quota-exceeded. Stored value is JSON-encoded.
 *
 * `legacyKey` reads (but never writes) an older storage key, so renamed keys
 * migrate on first load instead of dropping the cached value.
 */
export function persist<T>(key: string, initial: T, legacyKey?: string): Signal<T> {
    const storage = activeStorage();
    let seed = initial;

    if (storage) {
        const raw = readRaw(storage, key, legacyKey);
        if (raw !== undefined) seed = raw as T;
    }

    const signal = createSignal<T>(seed);

    signal.subscribe((value) => {
        const target = activeStorage();
        if (!target) return;
        try {
            target.setItem(key, JSON.stringify(value));
        } catch {
            // Quota / serialization failure — silently keep going; in-memory stays authoritative.
        }
    });

    registry.push({
        key,
        legacyKey,
        hydrate: (target) => {
            const raw = readRaw(target, key, legacyKey);
            if (raw !== undefined) signal.set(raw as T);
        },
    });

    return signal;
}

function readRaw(storage: PersistStorage, key: string, legacyKey?: string): unknown {
    for (const candidate of legacyKey ? [key, legacyKey] : [key]) {
        try {
            const raw = storage.getItem(candidate);
            if (raw !== null) return JSON.parse(raw);
        } catch {
            // Corrupt value; try the next candidate / fall through to initial.
        }
    }
    return undefined;
}

function activeStorage(): PersistStorage | null {
    return injectedStorage ?? getSafeStorage();
}

// `undefined` = not probed yet; `null` = probed and unusable. Memoized because
// `activeStorage` now runs on every persisted write, not just at creation.
let browserStorage: Storage | null | undefined;

function getSafeStorage(): Storage | null {
    if (browserStorage !== undefined) return browserStorage;
    // React Native defines `window` (an alias of `global`) but not
    // `window.localStorage`, so the probe below — not the typeof check — is
    // what routes RN to in-memory (or to an injected PersistStorage).
    if (typeof window === 'undefined') return (browserStorage = null);
    try {
        const s = window.localStorage;
        // Some browsers throw on access in private-mode iframes.
        s.getItem('__langsys_probe__');
        return (browserStorage = s);
    } catch {
        return (browserStorage = null);
    }
}
