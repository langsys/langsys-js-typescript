import { createSignal, type Signal } from './signal.js';

/**
 * Create a Signal whose value is persisted to localStorage (when available).
 * Falls back to in-memory behavior during SSR or when storage is unavailable
 * or quota-exceeded. Stored value is JSON-encoded.
 */
export function persist<T>(key: string, initial: T): Signal<T> {
    const storage = getSafeStorage();
    let seed = initial;

    if (storage) {
        try {
            const raw = storage.getItem(key);
            if (raw !== null) seed = JSON.parse(raw) as T;
        } catch {
            // Corrupt value; fall through to initial.
        }
    }

    const signal = createSignal<T>(seed);

    if (storage) {
        signal.subscribe((value) => {
            try {
                storage.setItem(key, JSON.stringify(value));
            } catch {
                // Quota / serialization failure — silently keep going; in-memory stays authoritative.
            }
        });
    }

    return signal;
}

function getSafeStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        const s = window.localStorage;
        // Some browsers throw on access in private-mode iframes.
        s.getItem('__langsys_probe__');
        return s;
    } catch {
        return null;
    }
}
