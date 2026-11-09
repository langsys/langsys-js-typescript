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

describe('a catalog is saved only under its own locale’s key', () => {
    /**
     * A seed or fetch names the locale its catalog is for (`publishCatalog`). One
     * landing while the cache is scoped to another locale used to be saved under
     * that locale's key, and while catalog fetches failed every later visit
     * served it as that locale: a Spanish seed with an Italian user store left
     * Spanish under `…:it-it`.
     */
    it('a catalog for another locale renders but is not saved under the current scope', async () => {
        const data = installStorage();
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Hola'), 'es-es');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Hola');
        expect(data['langsys:translations:p1:it-it']).toBeUndefined();
    });

    it('control: a catalog for the current scope’s locale is saved', async () => {
        const data = installStorage();
        const { scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Ciao'), 'it-it');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('an in-place edit of a mislabelled catalog is not saved under the current scope either', async () => {
        // The flush writes the catalog back with its new keys marked known, through a plain `set`.
        const data = installStorage();
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Hola'), 'es-es');
        sTranslations.set({ ...sTranslations.get() });

        expect(data['langsys:translations:p1:it-it']).toBeUndefined();
    });

    it('scoping to the catalog’s own locale keeps it and saves it there, over a stale copy', async () => {
        const data = installStorage({ 'langsys:translations:p1:es-es': JSON.stringify(catalog('Hello', 'STALE')) });
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Hola'), 'es-es');
        scopeCatalogCache('p1:es-es');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Hola');
        expect(JSON.parse(data['langsys:translations:p1:es-es']!).__uncategorized__.Hello).toBe('Hola');
    });

    it('a seed for another locale before the first scoping is not saved under it', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        publishCatalog(catalog('Hello', 'Hola'), 'es-es');
        scopeCatalogCache('p1:it-it');

        // The seed is what this page was handed, so it still renders until the right catalog loads.
        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Hola');
        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('a catalog fetched for one project is not saved under another project’s same locale', async () => {
        const data = installStorage();
        const { scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p2:es-es');
        publishCatalog(catalog('Hello', 'P1-Hola'), 'p1:es-es');

        expect(data['langsys:translations:p2:es-es']).toBeUndefined();
    });

    it('leaving a scope drops the label, so the reset catalog is never saved as the labelled locale’s', async () => {
        const data = installStorage();
        const { scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Hola'), 'es-es');
        scopeCatalogCache('p1:fr-fr'); // nothing stored: reset to the empty catalog
        scopeCatalogCache('p1:es-es');

        expect(data['langsys:translations:p1:es-es']).toBeUndefined();
    });

    it('a seed labelled by locale belongs to the first project it is scoped under, not every project', async () => {
        // A re-init for another project, same locale: the seed kept by the first scoping must not
        // be kept again, nor saved over the second project's stored catalog.
        const data = installStorage({ 'langsys:translations:p2:es-es': JSON.stringify(catalog('Hello', 'P2-Hola')) });
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        publishCatalog(catalog('Hello', 'P1-SEED'), 'es-es');
        scopeCatalogCache('p1:es-es');
        scopeCatalogCache('p2:es-es');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('P2-Hola');
        expect(JSON.parse(data['langsys:translations:p2:es-es']!).__uncategorized__.Hello).toBe('P2-Hola');
        expect(JSON.parse(data['langsys:translations:p1:es-es']!).__uncategorized__.Hello).toBe('P1-SEED');
    });

    it('so does a seed published while already scoped', async () => {
        const data = installStorage({ 'langsys:translations:p2:es-es': JSON.stringify(catalog('Hello', 'P2-Hola')) });
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:es-es');
        publishCatalog(catalog('Hello', 'P1-SEED'), 'es-es');
        scopeCatalogCache('p2:es-es');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('P2-Hola');
        expect(JSON.parse(data['langsys:translations:p2:es-es']!).__uncategorized__.Hello).toBe('P2-Hola');
    });

    it('a plain set then the loaded locale, before scoping, is labelled by that locale', async () => {
        // langsys-js-svelte's SSR guide seeds this way in the root layout's body.
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.set('es-ES');
        scopeCatalogCache('p1:it-it');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Hola');
        expect(data['langsys:translations:p1:it-it']).toBeUndefined();
    });

    it('a plain set saved under the scope is undone when the loaded locale says it is another’s', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.set('es-es');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Hola');
        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('…and removed again where the scope held nothing before it', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.set('es-es');

        expect(data['langsys:translations:p1:it-it']).toBeUndefined();
    });

    it('control: a plain set whose loaded locale matches the scope stays saved', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Ciao-NEW'));
        currentlyLoadedLocale.set('it-it');
        sTranslations.set(catalog('Hello', 'Ciao-EDITED'));

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao-EDITED');
    });

    it('control: a published catalog’s edits are not undone by its own locale arriving later', async () => {
        // A fetch publishes, a flush writes back with keys marked known, then the 100 ms locale lands.
        const data = installStorage();
        const { setLoadedLocale, sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Ciao'), 'p1:it-it');
        sTranslations.set({ ...sTranslations.get(), __uncategorized__: { ...sTranslations.get().__uncategorized__, Known: null as unknown as string } });
        setLoadedLocale('it-it');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__).toHaveProperty('Known', null);
    });

    it('the loaded locale is compared in canonical form', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:es-es');
        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.set('es-ES');

        expect(JSON.parse(data['langsys:translations:p1:es-es']!).__uncategorized__.Hello).toBe('Hola');
    });

    it('a published catalog is never undone by a locale that does not own it', async () => {
        // A superseded fetch's 100 ms locale can land after the next catalog was published.
        const data = installStorage();
        const { setLoadedLocale, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        publishCatalog(catalog('Hello', 'Ciao'), 'p1:it-it');
        setLoadedLocale('es-es');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('several plain sets are undone to what the key held before the first', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Hola-1'));
        sTranslations.set(catalog('Hello', 'Hola-2'));
        currentlyLoadedLocale.set('es-es');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('a plain seed saved by the first scoping is undone when its locale arrives after', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        sTranslations.set(catalog('Hello', 'Hola'));
        scopeCatalogCache('p1:it-it');
        currentlyLoadedLocale.set('es-es');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('a copy adopted on returning to a scope is that scope’s, and a later locale does not undo it', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Ciao-EDITED'));
        scopeCatalogCache('p1:fr-fr');
        scopeCatalogCache('p1:it-it');
        currentlyLoadedLocale.set('es-es');

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao-EDITED');
    });

    it('a superseded fetch’s late locale does not relabel the catalog adopted since', async () => {
        // fr's fetch publishes, the user switches to de (adopting its stored copy), fr's 100 ms locale
        // lands, and the user switches back before de's fetch does: fr's stored copy must come back.
        const data = installStorage({
            'langsys:translations:p:fr-fr': JSON.stringify(catalog('Hello', 'Bonjour-STORED')),
            'langsys:translations:p:de-de': JSON.stringify(catalog('Hello', 'Hallo')),
        });
        const { setLoadedLocale, sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        publishCatalog(catalog('Hello', 'Bonjour'), 'p:fr-fr');
        scopeCatalogCache('p:de-de');
        setLoadedLocale('fr-fr');
        scopeCatalogCache('p:fr-fr');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Bonjour');
        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('…nor the empty catalog a switch reset to', async () => {
        const data = installStorage();
        const { setLoadedLocale, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        publishCatalog(catalog('Hello', 'Bonjour'), 'p:fr-fr');
        scopeCatalogCache('p:de-de');
        setLoadedLocale('fr-fr');
        scopeCatalogCache('p:fr-fr');

        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('a late locale does not undo the core’s own edit of the catalog published since', async () => {
        // de publishes inside fr's 100 ms, the flush marks a key known, then fr's locale lands.
        const data = installStorage();
        const { setLoadedLocale, scopeCatalogCache, publishCatalog, editCatalog } = await freshLoad();

        scopeCatalogCache('p:de-de');
        publishCatalog(catalog('Hello', 'Hallo'), 'p:de-de');
        editCatalog((c) => ({ ...c, __uncategorized__: { ...c.__uncategorized__, Known: null as unknown as string } }));
        setLoadedLocale('fr-fr');

        expect(JSON.parse(data['langsys:translations:p:de-de']!).__uncategorized__).toHaveProperty('Known', null);
    });

    it('a late locale after a switch reset the catalog does not label the empty catalog', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        sTranslations.set(catalog('Hello', 'Bonjour'));
        scopeCatalogCache('p:de-de'); // nothing stored: reset
        currentlyLoadedLocale.set('fr-fr');
        scopeCatalogCache('p:fr-fr');

        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('a claim answers one plain set: a second, later locale does not relabel again', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache, editCatalog } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.set('es-es');
        currentlyLoadedLocale.set('it-it');
        editCatalog((c) => ({ ...c }));

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });

    it('a binding’s edit inside a fetch’s 100 ms does not let the fetch’s late locale claim the catalog', async () => {
        const data = installStorage({ 'langsys:translations:p:de-de': JSON.stringify(catalog('Hello', 'Hallo')) });
        const { sTranslations, setLoadedLocale, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        publishCatalog(catalog('Hello', 'Bonjour'), 'p:fr-fr');
        scopeCatalogCache('p:de-de');
        sTranslations.update((c) => ({ ...c }));
        setLoadedLocale('fr-fr');
        scopeCatalogCache('p:fr-fr');

        expect(sTranslations.get().__uncategorized__?.['Hello']).toBe('Bonjour');
        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('…nor after a binding’s own seed and claim, then an edit', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, setLoadedLocale, scopeCatalogCache, publishCatalog, editCatalog } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        publishCatalog(catalog('Hello', 'Bonjour'), 'p:fr-fr');
        sTranslations.set(catalog('Hello', 'Hallo'));
        currentlyLoadedLocale.set('de-de');
        sTranslations.update((c) => ({ ...c }));
        setLoadedLocale('fr-fr');
        editCatalog((c) => ({ ...c }));

        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('a binding setting the locale already loaded still claims its plain set', async () => {
        // The loaded locale is de (a de fetch's late timer after a switch to fr); the binding then
        // seeds a de catalog and sets de again, which the signal itself would not re-emit.
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, setLoadedLocale, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p:fr-fr');
        publishCatalog(catalog('Hello', 'Bonjour'), 'p:fr-fr');
        setLoadedLocale('de-de');
        sTranslations.set(catalog('Hello', 'Hallo'));
        currentlyLoadedLocale.set('de-de');

        expect(JSON.parse(data['langsys:translations:p:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('currentlyLoadedLocale.update claims as set does', async () => {
        const data = installStorage();
        const { sTranslations, currentlyLoadedLocale, scopeCatalogCache } = await freshLoad();

        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Hola'));
        currentlyLoadedLocale.update(() => 'es-es');

        expect(data['langsys:translations:p1:it-it']).toBeUndefined();
    });

    it('a stored copy adopted on scoping is that scope’s, so later edits save there', async () => {
        const data = installStorage({ 'langsys:translations:p1:it-it': JSON.stringify(catalog('Hello', 'Ciao')) });
        const { sTranslations, scopeCatalogCache, publishCatalog } = await freshLoad();

        scopeCatalogCache('p1:es-es');
        publishCatalog(catalog('Hello', 'Hola'), 'es-es');
        scopeCatalogCache('p1:it-it');
        sTranslations.set(catalog('Hello', 'Ciao-EDITED'));

        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao-EDITED');
        expect(JSON.parse(data['langsys:translations:p1:es-es']!).__uncategorized__.Hello).toBe('Hola');
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

    // Both ways a seed reached the wrong key, with every catalog fetch failing (an outage),
    // which is when a mislabelled copy was served on every later visit.
    const OUTAGE = { status: false, errors: ['HTTP 503'] };

    it('initialTranslations for another locale are not saved under the user’s locale', async () => {
        const { LangsysApp, createSignal, authorize, data, t } = await page({}, { 'it-it': OUTAGE });

        const done = LangsysApp.init({
            projectid: 'p1',
            key: 'k',
            UserLocaleStore: createSignal('it-it'),
            initialTranslations: catalog('Hello', 'Hola'),
            initialTranslationsLocale: 'es-es',
        });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(t('Hello')).toBe('Hola');
        expect(data['langsys:translations:p1:it-it'] ?? '').not.toContain('Hola');
    });

    it('a catalog seeded before init() for another locale is not saved under the user’s locale', async () => {
        const { LangsysApp, createSignal, authorize, data } = await page({}, { 'it-it': OUTAGE });

        LangsysApp.seedCatalog(catalog('Hello', 'Hola'), 'es-es');
        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('it-it') });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(data['langsys:translations:p1:it-it'] ?? '').not.toContain('Hola');
    });

    it('a binding’s plain seed (set, then the loaded locale) for another locale is not saved under the user’s', async () => {
        const { LangsysApp, createSignal, authorize, data, stores } = await page({}, { 'it-it': OUTAGE });

        stores.sTranslations.set(catalog('Hello', 'Hola'));
        stores.currentlyLoadedLocale.set('es-es');
        const done = LangsysApp.init({
            projectid: 'p1',
            key: 'k',
            UserLocaleStore: createSignal('it-it'),
            initialTranslations: catalog('Hello', 'Hola'),
            initialTranslationsLocale: 'es-es',
        });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(data['langsys:translations:p1:it-it'] ?? '').not.toContain('Hola');
    });

    it('the flush’s write-back is the core’s own edit: a late locale does not undo its known keys', async () => {
        const { LangsysApp, createSignal, authorize, data, stores, t } = await page({}, { 'fr-fr': live({ Hello: 'Bonjour' }) });

        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-fr') });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(1_000);
        t('Brand new');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(JSON.parse(data['langsys:translations:p1:fr-fr']!).__uncategorized__).toHaveProperty('Brand new', null);

        // A superseded fetch's locale, landing after the write-back.
        stores.setLoadedLocale('de-de');

        expect(JSON.parse(data['langsys:translations:p1:fr-fr']!).__uncategorized__).toHaveProperty('Brand new', null);
    });

    it('a fetch’s late locale after a quick switch away and back leaves the stored catalog alone', async () => {
        // fr's fetch lands; inside its 100 ms the user switches to de (stored copy adopted, its fetch
        // still out) and a binding edits the catalog; fr's locale lands; the user switches back.
        let frFetches = 0;
        const { LangsysApp, createSignal, authorize, data, stores } = await page(
            { 'langsys:translations:p1:de-de': JSON.stringify(catalog('Hello', 'Hallo')) },
            {
                // The first fr fetch answers; the one switching back fails (an outage), so nothing corrects the cache.
                get 'fr-fr'() {
                    return frFetches++ ? OUTAGE : live({ Hello: 'Bonjour' });
                },
                'de-de': new Promise(() => {}),
            }
        );
        const locale = createSignal('fr-fr');

        const done = LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: locale });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(0);
        expect(JSON.parse(data['langsys:translations:p1:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');

        locale.set('de-de');
        stores.sTranslations.update((c) => ({ ...c }));
        await vi.advanceTimersByTimeAsync(150);
        locale.set('fr-fr');
        await vi.advanceTimersByTimeAsync(150);

        expect(frFetches).toBe(2);
        expect(JSON.parse(data['langsys:translations:p1:fr-fr']!).__uncategorized__.Hello).toBe('Bonjour');
    });

    it('control: a catalog fetched for the user’s locale after a mismatched seed is saved there', async () => {
        const { LangsysApp, createSignal, authorize, data, t } = await page({}, { 'it-it': live({ Hello: 'Ciao' }) });

        const done = LangsysApp.init({
            projectid: 'p1',
            key: 'k',
            UserLocaleStore: createSignal('it-it'),
            initialTranslations: catalog('Hello', 'Hola'),
            initialTranslationsLocale: 'es-es',
        });
        authorize.resolve(AUTHORIZED);
        await done;
        await vi.advanceTimersByTimeAsync(5_000);

        expect(t('Hello')).toBe('Ciao');
        expect(JSON.parse(data['langsys:translations:p1:it-it']!).__uncategorized__.Hello).toBe('Ciao');
    });
});
