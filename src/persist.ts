import { createSignal, type Signal } from './signal.js';

/**
 * Create a Signal whose value is persisted to localStorage (when available).
 * Falls back to in-memory behavior during SSR or when storage is unavailable
 * or quota-exceeded. Stored value is JSON-encoded.
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
