import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { persist, setPersistStorage, type PersistStorage } from '../src/persist.js';

/**
 * `persist` was localStorage-or-nothing. React Native defines `window` but not
 * `window.localStorage`, so every RN consumer silently ran in-memory: the
 * catalog was re-fetched on every cold start, and nothing said so.
 */

function memoryStorage(seed: Record<string, string> = {}): PersistStorage & { data: Record<string, string> } {
    const data = { ...seed };
    return {
        data,
        getItem: (k: string) => (k in data ? data[k] : null),
        setItem: (k: string, v: string) => {
            data[k] = v;
        },
    };
}

afterEach(() => {
    setPersistStorage(null);
    vi.unstubAllGlobals();
});

describe('an injected storage backend', () => {
    it('seeds a new signal from it', () => {
        setPersistStorage(memoryStorage({ 'langsys:k': JSON.stringify({ a: 1 }) }));
        expect(persist('langsys:k', { a: 0 }).get()).toEqual({ a: 1 });
    });

    it('receives every write', () => {
        const store = memoryStorage();
        setPersistStorage(store);

        const s = persist('langsys:k', { a: 0 });
        s.set({ a: 2 });

        expect(JSON.parse(store.data['langsys:k'])).toEqual({ a: 2 });
    });

    it('re-hydrates signals that already existed when it was injected', () => {
        // The catalog store is built at module load, long before an RN app can
        // hand us MMKV. Without re-hydration the injection would apply only to
        // signals created afterwards — which is none of the ones that matter.
        const s = persist('langsys:late', { a: 0 });
        expect(s.get()).toEqual({ a: 0 });

        setPersistStorage(memoryStorage({ 'langsys:late': JSON.stringify({ a: 9 }) }));

        expect(s.get()).toEqual({ a: 9 });
    });

    it('is dropped again by passing null', () => {
        const store = memoryStorage({ 'langsys:k2': JSON.stringify({ a: 5 }) });
        setPersistStorage(store);
        setPersistStorage(null);

        expect(persist('langsys:k2', { a: 0 }).get()).toEqual({ a: 0 });
    });
});

describe('a renamed key migrates instead of dropping the cache', () => {
    it('reads the legacy key when the current one is absent', () => {
        setPersistStorage(memoryStorage({ translations: JSON.stringify({ a: 1 }) }));
        expect(persist('langsys:translations', { a: 0 }, 'translations').get()).toEqual({ a: 1 });
    });

    it('prefers the current key when both exist', () => {
        setPersistStorage(
            memoryStorage({
                translations: JSON.stringify({ a: 1 }),
                'langsys:translations': JSON.stringify({ a: 2 }),
            })
        );
        expect(persist('langsys:translations', { a: 0 }, 'translations').get()).toEqual({ a: 2 });
    });

    it('never writes back to the legacy key', () => {
        const store = memoryStorage({ translations: JSON.stringify({ a: 1 }) });
        setPersistStorage(store);

        persist('langsys:translations', { a: 0 }, 'translations').set({ a: 3 });

        expect(JSON.parse(store.data['langsys:translations'])).toEqual({ a: 3 });
        // Untouched: a host app downgrading the SDK still finds its old cache.
        expect(JSON.parse(store.data['translations'])).toEqual({ a: 1 });
    });
});

describe('falling back without a backend', () => {
    it('stays in memory when there is no window at all', () => {
        vi.stubGlobal('window', undefined);
        const s = persist('langsys:ssr', { a: 0 });
        s.set({ a: 1 });
        expect(s.get()).toEqual({ a: 1 });
    });

    it('stays in memory when window exists but localStorage does not', () => {
        // The React Native shape. `typeof window !== 'undefined'` is true there,
        // which is why the probe rather than the typeof check has to decide.
        vi.stubGlobal('window', {});
        const s = persist('langsys:rn', { a: 0 });
        s.set({ a: 1 });
        expect(s.get()).toEqual({ a: 1 });
    });
});
