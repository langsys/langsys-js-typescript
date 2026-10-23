import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { iCategories } from '../src/types/translations.js';

/**
 * CACHE-1 — the catalog cache is keyed by project AND locale.
 *
 * It used to be keyed by neither. A page load restored whatever catalog was in
 * `translations` and `t()` served it before anything could check whose it was:
 * a visitor who used the app in French saw French until the English fetch
 * landed, and two projects sharing an origin overwrote and then served each
 * other's content. Both failed silently — no error, just wrong strings.
 */

function catalog(phrase: string, value: string): iCategories {
    return {
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__', [phrase]: value },
    } as iCategories;
}

/** A localStorage stand-in whose contents each test controls. */
function installStorage(seed: Record<string, string> = {}) {
    const data = { ...seed };
    const storage = {
        getItem: (k: string) => (k in data ? data[k]! : null),
        setItem: (k: string, v: string) => void (data[k] = v),
        removeItem: (k: string) => void delete data[k],
    };
    vi.stubGlobal('window', { localStorage: storage });
    return data;
}

/** Fresh module graph = a fresh page load. */
async function freshLoad() {
    vi.resetModules();
    return import('../src/stores.js');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('a page load serves nothing until the identity is known', () => {
    it('does not restore a catalog before a scope is set', async () => {
        installStorage({ 'langsys:translations:proj-a:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')) });
        const { sTranslations } = await freshLoad();

        // The signal holds the empty skeleton, so t() falls back to source text
        // — correct — rather than to the last session's language.
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBeUndefined();
    });

    it('ignores the superseded unscoped keys entirely, and removes them', async () => {
        const data = installStorage({
            translations: JSON.stringify(catalog('Hello', 'OLD-BARE')),
            'langsys:translations': JSON.stringify(catalog('Hello', 'OLD-NAMESPACED')),
        });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:en-us');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBeUndefined();
        expect(data['translations']).toBeUndefined();
        expect(data['langsys:translations']).toBeUndefined();
    });
});

describe('scoping adopts only the matching cache', () => {
    it('warms from the cache for this project and locale', async () => {
        installStorage({ 'langsys:translations:proj-a:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')) });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:fr-fr');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Bonjour');
    });

    it('does not serve another PROJECT its neighbour’s catalog', async () => {
        installStorage({ 'langsys:translations:proj-a:en-us': JSON.stringify(catalog('Hello', 'A-CONTENT')) });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:en-us');
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('A-CONTENT');

        scopeCatalogCache('proj-b:en-us');
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBeUndefined();
    });

    it('does not serve the previous LOCALE when the new one has no cache', async () => {
        // The language-flash case, which is the common one.
        installStorage({ 'langsys:translations:proj-a:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')) });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:fr-fr');
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Bonjour');

        scopeCatalogCache('proj-a:en-us');
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBeUndefined();
    });

    it('writes under the scoped key, not a shared one', async () => {
        const data = installStorage();
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:en-us');
        sTranslations.set(catalog('Hello', 'Hi'));

        expect(Object.keys(data)).toEqual(['langsys:translations:proj-a:en-us']);
    });
});

describe('an SSR-seeded catalog survives the first scoping', () => {
    it('beats a STORED catalog, not just an empty store', async () => {
        // The regression the first version of this suite missed: it only
        // covered the empty-store half, so the something-stored branch adopted
        // the stale copy unopposed. The server just rendered this page with a
        // fresh catalog, and markLoaded primes the 60s cache-hit so no
        // corrective fetch fires — a returning visitor to an SSR app would see
        // last session's strings for the whole session.
        const data = installStorage({
            'langsys:translations:proj-a:en-us': JSON.stringify(catalog('Hello', 'STALE-FROM-LAST-WEEK')),
        });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        sTranslations.set(catalog('Hello', 'FRESH-SSR'));
        scopeCatalogCache('proj-a:en-us');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('FRESH-SSR');
        // And the fresh value replaces the stale one, so the next load is right.
        expect(JSON.parse(data['langsys:translations:proj-a:en-us']!).__uncategorized__.Hello).toBe('FRESH-SSR');
    });

    it('still adopts the store when the signal was NOT seeded', async () => {
        // Control. Without it the fix above could be "never adopt anything",
        // which would silently disable the warm start entirely.
        installStorage({ 'langsys:translations:proj-a:en-us': JSON.stringify(catalog('Hello', 'FROM-CACHE')) });
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('proj-a:en-us');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('FROM-CACHE');
    });

    it('is not cleared when nothing is stored for that scope', async () => {
        // The handoff path seeds the signal before init scopes the cache. A
        // blanket reset on scope would throw the server’s work away and
        // force a refetch on every hydration.
        installStorage();
        const { sTranslations, scopeCatalogCache } = await freshLoad();

        sTranslations.set(catalog('Hello', 'FROM-SSR'));
        scopeCatalogCache('proj-a:en-us');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('FROM-SSR');
    });
});

describe('init() restores the cache before authorization answers', () => {
    /**
     * A returning visitor's catalog is in the cache under the project and locale `init()`
     * is called with, so `t()` renders it during the authorization round trip instead of
     * source text. Registration still decides only against the live catalog, and a refused
     * authorization leaves the restored catalog rendering, as a preloaded snapshot does.
     */
    const AUTHORIZED = { status: true, data: { key_type: 'write', write_enabled: true } };
    const REFUSED = { status: false, errors: ['HTTP 403: project_unavailable'] };
    const live = (entries: Record<string, string>) => ({ status: true, write_enabled: true, data: { __uncategorized__: entries } });

    function deferred<T>() {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => (resolve = r));
        return { promise, resolve };
    }

    /** A fresh page load with this storage, the API answered by hand. */
    async function page(stored: Record<string, string>, catalogs: Record<string, unknown> = {}) {
        const data = { ...stored };
        const localStorage = {
            getItem: (k: string) => (k in data ? data[k]! : null),
            setItem: (k: string, v: string) => void (data[k] = v),
            removeItem: (k: string) => void delete data[k],
        };
        vi.stubGlobal('window', { addEventListener: () => {}, location: { href: 'https://site.local/p' }, localStorage });
        vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' });
        vi.resetModules();
        const { LangsysApp } = await import('../src/langsys-app.js');
        const { LangsysAppAPI } = await import('../src/api.js');
        const { createSignal } = await import('../src/signal.js');
        const stores = await import('../src/stores.js');

        const authorize = deferred<unknown>();
        vi.spyOn(LangsysAppAPI, 'validate').mockReturnValue(authorize.promise as never);
        vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: false } as never);
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockImplementation(async (locale: string) => (catalogs[locale] ?? live({})) as never);
        const posted: string[] = [];
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
            for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase));
            return { status: true } as never;
        });
        vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });

        const t = (phrase: string) => LangsysApp.Translations.tSignal.get()(phrase as never);
        return { LangsysApp, createSignal, stores, authorize, posted, data, t };
    }

    beforeEach(() => {
        for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
            vi.spyOn(console, m).mockImplementation(() => {});
        }
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('a returning visitor’s cached text renders while authorization is in flight', async () => {
        const { LangsysApp, createSignal, stores, t } = await page({
            'langsys:translations:p1:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')),
        });

        void LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-FR') });

        expect(t('Hello')).toBe('Bonjour');
        // Restored, not loaded: the loaded locale still names nothing this session fetched.
        expect(stores.currentlyLoadedLocale.get()).toBe('');
    });

    it('control: another project’s cache, or another locale’s, is not restored', async () => {
        const { LangsysApp, createSignal, t } = await page({
            'langsys:translations:p2:fr-fr': JSON.stringify(catalog('Hello', 'P2')),
            'langsys:translations:p1:de-de': JSON.stringify(catalog('Hello', 'Hallo')),
        });

        void LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-fr') });

        expect(t('Hello')).toBe('Hello');
    });

    it('a refused authorization keeps the cached catalog rendering', async () => {
        const { LangsysApp, createSignal, authorize, t } = await page({
            'langsys:translations:p1:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')),
        });

        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-fr') });
        authorize.resolve(REFUSED);
        await done;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(t('Hello')).toBe('Bonjour');
    });

    it('initialTranslations replace a stale cached copy', async () => {
        const { LangsysApp, createSignal, authorize, data, t } = await page({
            'langsys:translations:p1:fr-fr': JSON.stringify(catalog('Hello', 'STALE')),
        });

        const done = LangsysApp.init({
            projectid: 'p1',
            key: 'k',
            UserLocaleStore: createSignal('fr-fr'),
            initialTranslations: catalog('Hello', 'FRESH-SSR'),
            initialTranslationsLocale: 'fr-fr',
        });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(t('Hello')).toBe('FRESH-SSR');
        expect(JSON.parse(data['langsys:translations:p1:fr-fr']!).__uncategorized__.Hello).toBe('FRESH-SSR');
    });

    it('a locale switch during authorization does not carry the first locale’s catalog over', async () => {
        const { LangsysApp, createSignal, authorize, data, t } = await page(
            {
                'langsys:translations:p1:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour')),
                'langsys:translations:p1:de-de': JSON.stringify(catalog('Hello', 'Hallo')),
            },
            { 'de-de': live({ Hello: 'Hallo-LIVE' }) }
        );
        const locale = createSignal('fr-fr');

        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: locale });
        expect(t('Hello')).toBe('Bonjour');
        locale.set('de-de');
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(1_000);

        expect(t('Hello')).toBe('Hallo-LIVE');
        expect(data['langsys:translations:p1:fr-fr']).not.toContain('Hallo');
        expect(data['langsys:translations:p1:de-de']).not.toContain('Bonjour');
    });

    it('a phrase only the cache holds still registers once the live catalog lacks it', async () => {
        const { LangsysApp, createSignal, authorize, posted, t } = await page(
            {
                'langsys:translations:p1:fr-fr': JSON.stringify({
                    __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__', Hello: 'Bonjour', Gone: 'Parti' },
                }),
            },
            { 'fr-fr': live({ Hello: 'Bonjour' }) }
        );

        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-fr') });
        // A reactive template: it renders now from the cache, and again on every new `t`.
        const unsubscribe = LangsysApp.Translations.tSignal.subscribe(() => {
            t('Hello');
            t('Gone');
        });
        expect(t('Gone')).toBe('Parti');

        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(5_000);
        unsubscribe();

        expect(posted).toEqual(['Gone']);
    });
});
