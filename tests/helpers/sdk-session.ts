import { _resetDiscoveryState } from '../../src/discovery.js';
import { LangsysApp } from '../../src/langsys-app.js';
import { createSignal } from '../../src/signal.js';
import {
    autoDiscovery,
    batchLimit,
    catalogUnavailable,
    currentlyLoadedLocale,
    discoveryBaseLocaleOnly,
    sTranslations,
    writeEnabled,
} from '../../src/stores.js';
import { _resetCapabilityNotice } from '../../src/translations.js';

/**
 * Drives the SDK's real path — `LangsysApp.init`, the real HTTP client, real `fetch` — as a
 * browser session, for tests graded against the contract double.
 *
 * The core is a singleton, so each session starts by clearing what a previous session left:
 * the registration queue, capability, the catalog and the discovery lane.
 */

const g = globalThis as unknown as Record<string, unknown>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await sleep(25);
    }
    throw new Error(`condition not met within ${timeoutMs}ms`);
}

export function installBrowser(href = 'https://site.local/page'): void {
    const session = new Map<string, string>();
    g.sessionStorage = {
        getItem: (k: string) => session.get(k) ?? null,
        setItem: (k: string, v: string) => void session.set(k, v),
        removeItem: (k: string) => void session.delete(k),
    };
    g.window = { addEventListener: () => {}, removeEventListener: () => {}, location: { href }, sessionStorage: g.sessionStorage };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
}

export function setHref(href: string): void {
    (g.window as { location: { href: string } }).location.href = href;
}

export function resetSdk(): void {
    const T = LangsysApp.Translations as unknown as Record<string, unknown> & { destroy(): void };
    T.destroy();
    if (T.debounceTimer) clearTimeout(T.debounceTimer as ReturnType<typeof setTimeout>);
    Object.assign(T, {
        missingTokens: [],
        lastLoaded: {},
        catalogFetchesInFlight: 0,
        flushScheduled: false,
        updateInFlight: false,
        debounceTimer: null,
        consecutiveFailures: 0,
        retryNotBefore: 0,
        // CACHE-2's per-pair failure window and shared requests: a session starts with none.
        catalogFailures: new Map(),
        catalogRequests: new Map(),
    });
    writeEnabled.set(undefined);
    autoDiscovery.set(undefined);
    catalogUnavailable.set(false);
    discoveryBaseLocaleOnly.set(false);
    batchLimit.set(200);
    currentlyLoadedLocale.set('');
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
    _resetDiscoveryState();
    _resetCapabilityNotice();
}

export async function session(
    baseUrl: string,
    key: string,
    opts: { project?: string; locale?: string; awaitCatalog?: boolean } = {}
): Promise<void> {
    const locale = opts.locale ?? 'es-es';
    resetSdk();
    await LangsysApp.init({ projectid: opts.project ?? 'p1', key, UserLocaleStore: createSignal(locale), baseLocale: 'en', apiUrl: baseUrl });
    if (opts.awaitCatalog !== false) await until(() => currentlyLoadedLocale.get() === locale);
}

export const t = (phrase: string, category = 'UI') =>
    (LangsysApp.Translations.tSignal.get() as unknown as (p: string, c: string) => string)(phrase, category);
