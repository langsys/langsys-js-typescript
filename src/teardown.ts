/**
 * A host's own "the app is going away" signal, for runtimes with no `document` to listen to.
 *
 * In a browser the core flushes queued registrations itself, on `visibilitychange → hidden` and
 * `pagehide` (REG-3). React Native defines `window` but has no `document`, so those listeners
 * cannot exist there, and anything still queued when the app is backgrounded or killed would be
 * lost. `setTeardownSignal` lets the host supply the signal instead: the React Native binding
 * adapts `AppState` leaving `active`, and the core keeps the send.
 *
 * Same shape as `setPersistStorage`: a module-level injection that reaches every `Translations`
 * instance, those set up before it and after.
 */

/**
 * Subscribe `fire` to the host's teardown signal and return a function that unsubscribes it.
 * The core calls `fire` nothing else: firing it runs the ordinary teardown flush.
 */
export type TeardownSubscribe = (fire: () => void) => (() => void) | void;

const targets = new Set<() => void>();
let release: (() => void) | null = null;

/**
 * Inject the host's teardown signal, replacing any previous one. The previous subscription is
 * released first, so a re-injection — React Native's Fast Refresh, a test — never leaves two
 * live subscriptions that would flush twice. `null` releases the current one and injects none.
 *
 * Fire it once per departure, edge-triggered, as the app leaves the foreground: the flush sends
 * what is queued, and firing again while nothing is queued sends nothing.
 */
export function setTeardownSignal(subscribe: TeardownSubscribe | null): void {
    const previous = release;
    release = null;
    previous?.();
    if (!subscribe) return;
    const unsubscribe = subscribe(() => {
        for (const flush of targets) flush();
    });
    release = typeof unsubscribe === 'function' ? unsubscribe : null;
}

/** Register a flush to run when the injected signal fires. Returns its unregistration. */
export function _registerTeardownFlush(flush: () => void): () => void {
    targets.add(flush);
    return () => {
        targets.delete(flush);
    };
}
