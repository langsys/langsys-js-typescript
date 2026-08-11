import { describe, expect, it, vi } from 'vitest';
import { createSignal, getValue } from '../src/signal.js';

/**
 * `createSignal` is the reactivity primitive every framework binding rides on
 * (Vue/Solid/React Native all wrap `subscribe`), so its notification contract
 * is load-bearing far outside this package.
 */
describe('createSignal — subscription contract', () => {
    it('calls a new subscriber synchronously with the current value', () => {
        const signal = createSignal('en-US');
        const seen: string[] = [];

        signal.subscribe((v) => seen.push(v));

        expect(seen).toEqual(['en-US']); // synchronous, not deferred to a microtask
    });

    it('notifies every subscriber on set, in registration order', () => {
        const signal = createSignal(0);
        const order: string[] = [];

        signal.subscribe(() => order.push('first'));
        signal.subscribe(() => order.push('second'));
        order.length = 0; // drop the immediate-on-subscribe calls

        signal.set(1);

        expect(order).toEqual(['first', 'second']);
    });

    it('stops notifying after unsubscribe', () => {
        const signal = createSignal(0);
        const run = vi.fn();

        const unsubscribe = signal.subscribe(run);
        unsubscribe();
        signal.set(1);

        expect(run).toHaveBeenCalledTimes(1); // the immediate call only
    });

    it('unsubscribes only the calling subscriber', () => {
        const signal = createSignal(0);
        const kept = vi.fn();
        const dropped = vi.fn();

        signal.subscribe(kept);
        const unsubscribe = signal.subscribe(dropped);
        unsubscribe();
        signal.set(1);

        expect(kept).toHaveBeenCalledTimes(2);
        expect(dropped).toHaveBeenCalledTimes(1);
    });

    it('tolerates a subscriber unsubscribing itself mid-notification', () => {
        const signal = createSignal(0);
        const after = vi.fn();
        let unsubscribe: () => void = () => {};

        unsubscribe = signal.subscribe(() => unsubscribe());
        signal.subscribe(after);

        expect(() => signal.set(1)).not.toThrow();
        expect(after).toHaveBeenCalledTimes(2);
    });
});

describe('createSignal — change detection', () => {
    it('skips notification when the value is unchanged', () => {
        const signal = createSignal('en-US');
        const run = vi.fn();

        signal.subscribe(run);
        signal.set('en-US');

        expect(run).toHaveBeenCalledTimes(1); // no redundant re-render downstream
    });

    it('notifies on a new object identity even when contents match', () => {
        const signal = createSignal<{ a: number }>({ a: 1 });
        const run = vi.fn();

        signal.subscribe(run);
        signal.set({ a: 1 }); // Object.is is identity-based, not structural

        expect(run).toHaveBeenCalledTimes(2);
    });

    it('treats NaN as unchanged (Object.is, not ===)', () => {
        const signal = createSignal(Number.NaN);
        const run = vi.fn();

        signal.subscribe(run);
        signal.set(Number.NaN);

        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe('createSignal — update and get', () => {
    it('derives the next value from the current one', () => {
        const signal = createSignal(1);

        signal.update((v) => v + 1);

        expect(signal.get()).toBe(2);
    });

    it('notifies subscribers on update', () => {
        const signal = createSignal(1);
        const run = vi.fn();

        signal.subscribe(run);
        signal.update((v) => v + 1);

        expect(run).toHaveBeenLastCalledWith(2);
    });

    it('skips notification when the updater returns the same value', () => {
        const signal = createSignal(1);
        const run = vi.fn();

        signal.subscribe(run);
        signal.update((v) => v);

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reads the current value without subscribing', () => {
        const signal = createSignal('fr-FR');

        expect(signal.get()).toBe('fr-FR');
        expect(getValue(signal)).toBe('fr-FR');
    });

    it('keeps get() in sync with the latest set', () => {
        const signal = createSignal('en-US');

        signal.set('ja-JP');

        expect(getValue(signal)).toBe('ja-JP');
    });
});
