import { afterEach, describe, expect, it, vi } from 'vitest';
import { persist, setPersistStorage, type PersistStorage } from '../src/persist.js';

/**
 * These run under vitest's `node` environment, so there is no `window` and
 * `getSafeStorage()` resolves to null — persisted signals are in-memory unless
 * a `PersistStorage` is injected. That mirrors the React Native / SSR path,
 * which is exactly what `setPersistStorage` exists to serve.
 *
 * Keys are unique per test: `persist` appends to a module-level registry that
 * never clears, so a later `setPersistStorage` re-hydrates every signal any
 * earlier test created.
 */
class FakeStorage implements PersistStorage {
    readonly map = new Map<string, string>();

    constructor(seed: Record<string, string> = {}) {
        for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
    }

    getItem(key: string): string | null {
        return this.map.has(key) ? (this.map.get(key) as string) : null;
    }

    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
}

afterEach(() => {
    setPersistStorage(null); // back to auto-detection for the next test
});

describe('persist — no storage available', () => {
    it('seeds from the initial value and stays in memory', () => {
        const signal = persist('mem-1', 'en-US');

        expect(signal.get()).toBe('en-US');

        signal.set('fr-FR');
        expect(signal.get()).toBe('fr-FR'); // no storage, but the signal still works
    });

    it('does not throw when there is nowhere to write', () => {
        const signal = persist('mem-2', 0);

        expect(() => signal.set(1)).not.toThrow();
    });
});

describe('persist — reading from injected storage', () => {
    it('seeds from the stored value instead of the initial', () => {
        setPersistStorage(new FakeStorage({ 'read-1': '"ja-JP"' }));

        expect(persist('read-1', 'en-US').get()).toBe('ja-JP');
    });

    it('falls back to the initial value when the key is absent', () => {
        setPersistStorage(new FakeStorage());

        expect(persist('read-2', 'en-US').get()).toBe('en-US');
    });

    it('falls back to the initial value when the stored JSON is corrupt', () => {
        setPersistStorage(new FakeStorage({ 'read-3': '{not json' }));

        expect(persist('read-3', 'en-US').get()).toBe('en-US'); // must not throw
    });

    it('round-trips non-string values through JSON', () => {
        setPersistStorage(new FakeStorage({ 'read-4': '{"a":[1,2]}' }));

        expect(persist('read-4', {} as { a: number[] }).get()).toEqual({ a: [1, 2] });
    });
});

describe('persist — writing to injected storage', () => {
    it('writes the seed at creation so storage is populated up front', () => {
        const storage = new FakeStorage();
        setPersistStorage(storage);

        persist('write-1', 'en-US');

        expect(storage.getItem('write-1')).toBe('"en-US"');
    });

    it('writes JSON-encoded on every change', () => {
        const storage = new FakeStorage();
        setPersistStorage(storage);

        persist('write-2', 'en-US').set('fr-FR');

        expect(storage.getItem('write-2')).toBe('"fr-FR"');
    });

    it('survives a storage backend that throws on write (quota)', () => {
        const storage = new FakeStorage();
        vi.spyOn(storage, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        setPersistStorage(storage);

        let signal: ReturnType<typeof persist<string>> | undefined;
        expect(() => {
            signal = persist('write-3', 'en-US'); // seed write throws inside
        }).not.toThrow();

        expect(() => signal?.set('fr-FR')).not.toThrow();
        expect(signal?.get()).toBe('fr-FR'); // in-memory stays authoritative
    });
});

describe('persist — legacyKey migration', () => {
    it('seeds from the legacy key when the current key is absent', () => {
        setPersistStorage(new FakeStorage({ 'legacy-old-1': '"ja-JP"' }));

        expect(persist('legacy-new-1', 'en-US', 'legacy-old-1').get()).toBe('ja-JP');
    });

    it('prefers the current key when both are present', () => {
        setPersistStorage(
            new FakeStorage({ 'legacy-new-2': '"fr-FR"', 'legacy-old-2': '"ja-JP"' }),
        );

        expect(persist('legacy-new-2', 'en-US', 'legacy-old-2').get()).toBe('fr-FR');
    });

    it('migrates the value onto the current key and never writes the legacy one', () => {
        const storage = new FakeStorage({ 'legacy-old-3': '"ja-JP"' });
        setPersistStorage(storage);

        persist('legacy-new-3', 'en-US', 'legacy-old-3').set('de-DE');

        expect(storage.getItem('legacy-new-3')).toBe('"de-DE"');
        expect(storage.getItem('legacy-old-3')).toBe('"ja-JP"'); // left untouched
    });

    it('falls through to the initial value when both keys are corrupt', () => {
        setPersistStorage(new FakeStorage({ 'legacy-new-4': '{bad', 'legacy-old-4': '{bad' }));

        expect(persist('legacy-new-4', 'en-US', 'legacy-old-4').get()).toBe('en-US');
    });
});

describe('setPersistStorage — late injection', () => {
    it('re-hydrates signals that were created before the storage existed', () => {
        // The catalog store is built at module load, before an RN app can
        // install its storage adapter — this is the case that motivates it.
        const signal = persist('late-1', 'en-US');
        expect(signal.get()).toBe('en-US');

        setPersistStorage(new FakeStorage({ 'late-1': '"ja-JP"' }));

        expect(signal.get()).toBe('ja-JP');
    });

    it('leaves a signal alone when the injected storage has no value for it', () => {
        const signal = persist('late-2', 'en-US');

        setPersistStorage(new FakeStorage());

        expect(signal.get()).toBe('en-US');
    });

    it('re-hydrates through the legacy key too', () => {
        const signal = persist('late-new-3', 'en-US', 'late-old-3');

        setPersistStorage(new FakeStorage({ 'late-old-3': '"ja-JP"' }));

        expect(signal.get()).toBe('ja-JP');
    });

    it('routes subsequent writes to the newly injected storage', () => {
        const signal = persist('late-4', 'en-US');
        const storage = new FakeStorage();

        setPersistStorage(storage);
        signal.set('fr-FR');

        expect(storage.getItem('late-4')).toBe('"fr-FR"');
    });

    it('notifies subscribers when hydration changes the value', () => {
        const signal = persist('late-5', 'en-US');
        const run = vi.fn();
        signal.subscribe(run);

        setPersistStorage(new FakeStorage({ 'late-5': '"ja-JP"' }));

        expect(run).toHaveBeenLastCalledWith('ja-JP');
    });

    it('stops writing to a detached storage after being reset to null', () => {
        const storage = new FakeStorage();
        setPersistStorage(storage);
        const signal = persist('late-6', 'en-US');

        setPersistStorage(null); // back to auto-detection — none under node
        signal.set('fr-FR');

        expect(storage.getItem('late-6')).toBe('"en-US"'); // the seed, not the update
    });
});
