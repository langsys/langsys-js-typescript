import { afterEach, describe, expect, it, vi } from 'vitest';
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
