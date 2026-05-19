/**
 * Tiny framework-agnostic reactive value holder — our replacement for a
 * Svelte `Writable<T>`. The shape is deliberately similar so the mental
 * model is identical: subscribe/set/update/get.
 *
 * Usage:
 *   const locale = createSignal('en-us');
 *   locale.subscribe((v) => console.log('locale is now', v));
 *   locale.set('fr-fr');
 *   locale.get();       // 'fr-fr'
 *
 * Subscribe is called synchronously with the current value on registration
 * (same semantics as a Svelte store).
 */
export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;
export type Updater<T> = (value: T) => T;

export interface Signal<T> {
    /** Register a subscriber; it's called immediately with the current value. Returns an unsubscribe function. */
    subscribe(run: Subscriber<T>): Unsubscriber;
    /** Set the value and notify subscribers. */
    set(value: T): void;
    /** Update the value via a function and notify subscribers. */
    update(fn: Updater<T>): void;
    /** Read the current value without subscribing. */
    get(): T;
}

export function createSignal<T>(initial: T): Signal<T> {
    let value: T = initial;
    const subscribers = new Set<Subscriber<T>>();

    const subscribe = (run: Subscriber<T>): Unsubscriber => {
        subscribers.add(run);
        run(value);
        return () => {
            subscribers.delete(run);
        };
    };

    const set = (next: T): void => {
        if (Object.is(value, next)) return;
        value = next;
        for (const run of subscribers) run(value);
    };

    const update = (fn: Updater<T>): void => {
        set(fn(value));
    };

    const get = (): T => value;

    return { subscribe, set, update, get };
}

/** Synchronously read a Signal's value. Mirrors svelte's `get(store)`. */
export function getValue<T>(signal: Signal<T>): T {
    return signal.get();
}
