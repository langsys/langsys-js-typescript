import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GATE-8: the API sends `write_enabled` on every answer that carries the decision, the
 * authorization's `data` and both catalog envelopes, and an answer without it is not
 * write-enabled, exactly as if it said false. Nothing registers, and a miss takes the
 * read-only lane (HINT-1). A cached payload is not an answer: the cache never holds the
 * decision (GATE-4), so a session whose only payload is cached holds it as unknown until
 * the API answers (GATE-2).
 *
 * Each place that reads the decision has a case of its own, since the catalog's answer
 * overwrites the authorization's: a key_type fallback in either place alone turns only
 * that place's case red.
 */

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

const CATALOG_WITHOUT_FIELD = { status: true, data: { __uncategorized__: {} } };
const CATALOG_WRITABLE = { status: true, write_enabled: true, data: { __uncategorized__: {} } };
const PAGE = 'https://site.local/p';

/** A fresh page load with this storage, the authorization and catalog answered by hand. */
async function page(stored: Record<string, string> = {}) {
    const data = { ...stored };
    const localStorage = {
        getItem: (k: string) => (k in data ? data[k]! : null),
        setItem: (k: string, v: string) => void (data[k] = v),
        removeItem: (k: string) => void delete data[k],
    };
    vi.stubGlobal('window', { addEventListener: () => {}, location: { href: PAGE }, localStorage });
    vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' });
    vi.resetModules();
    const { LangsysApp } = await import('../src/langsys-app.js');
    const { LangsysAppAPI } = await import('../src/api.js');
    const { createSignal } = await import('../src/signal.js');
    const { writeEnabled } = await import('../src/stores.js');

    const authorize = deferred<unknown>();
    const catalog = deferred<unknown>();
    vi.spyOn(LangsysAppAPI, 'validate').mockReturnValue(authorize.promise as never);
    vi.spyOn(LangsysAppAPI, 'get').mockResolvedValue({ status: false } as never);
    vi.spyOn(LangsysAppAPI, 'getTranslations').mockImplementation(() => catalog.promise as never);
    const posted: string[] = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase));
        return { status: true } as never;
    });
    const hinted: string[] = [];
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockImplementation(async (url: string) => {
        hinted.push(url);
        return { status: true } as never;
    });

    const start = () => LangsysApp.init({ projectid: 'p1', key: 'k', UserLocaleStore: createSignal('fr-fr') });
    const t = (phrase: string) => LangsysApp.Translations.tSignal.get()(phrase as never);
    return { start, authorize, catalog, posted, hinted, t, writeEnabled };
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
    vi.unstubAllGlobals();
});

describe('GATE-8: an answer without write_enabled is not write-enabled', () => {
    it('an authorization answer without it leaves a write key’s session not write-enabled', async () => {
        const { start, authorize, writeEnabled } = await page();
        void start();
        authorize.resolve({ status: true, data: { key_type: 'write' } });
        await vi.advanceTimersByTimeAsync(10);
        expect(writeEnabled.get()).toBe(false);
    });

    it('control: the same authorization saying true is write-enabled', async () => {
        const { start, authorize, writeEnabled } = await page();
        void start();
        authorize.resolve({ status: true, data: { key_type: 'write', write_enabled: true } });
        await vi.advanceTimersByTimeAsync(10);
        expect(writeEnabled.get()).toBe(true);
    });

    it('a catalog answer without it makes the session not write-enabled, whatever the authorization said', async () => {
        const { start, authorize, catalog, writeEnabled } = await page();
        const done = start();
        authorize.resolve({ status: true, data: { key_type: 'write', write_enabled: true } });
        await vi.advanceTimersByTimeAsync(10);
        expect(writeEnabled.get()).toBe(true);
        catalog.resolve(CATALOG_WITHOUT_FIELD);
        await done;
        expect(writeEnabled.get()).toBe(false);
    });

    it('a failed catalog read answers nothing about it: the decision held stays', async () => {
        const { start, authorize, catalog, writeEnabled } = await page();
        const done = start();
        authorize.resolve({ status: true, data: { key_type: 'write', write_enabled: true } });
        catalog.resolve({ status: false, errors: ['HTTP 503: Service Unavailable'] });
        await done;
        expect(writeEnabled.get()).toBe(true);
    });

    it('with both answers lacking it, a write key’s miss registers nothing and is reported on the read-only lane', async () => {
        const { start, authorize, catalog, posted, hinted, t } = await page();
        const done = start();
        authorize.resolve({ status: true, data: { key_type: 'write', auto_discovery: true } });
        catalog.resolve(CATALOG_WITHOUT_FIELD);
        await done;
        t('Not in the catalog');
        await vi.advanceTimersByTimeAsync(35_000);
        expect(posted).toEqual([]);
        expect(hinted).toEqual([PAGE]);
    });

    it('control: with both answers saying true, the same miss registers and is not reported', async () => {
        const { start, authorize, catalog, posted, hinted, t } = await page();
        const done = start();
        authorize.resolve({ status: true, data: { key_type: 'write', write_enabled: true, auto_discovery: true } });
        catalog.resolve(CATALOG_WRITABLE);
        await done;
        t('Not in the catalog');
        await vi.advanceTimersByTimeAsync(35_000);
        expect(posted).toEqual(['Not in the catalog']);
        expect(hinted).toEqual([]);
    });

    it('in a server render, a request scope’s catalog answer without it leaves the process not write-enabled', async () => {
        vi.resetModules();
        const { LangsysApp } = await import('../src/langsys-app.js');
        const { LangsysAppAPI } = await import('../src/api.js');
        const { createRequestScope } = await import('../src/request-scope.js');
        LangsysApp.Translations.applyWriteEnabled(true);
        expect(LangsysApp.Translations.mayWrite()).toBe(true);
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue(CATALOG_WITHOUT_FIELD as never);
        await createRequestScope({ locale: 'fr-fr' });
        expect(LangsysApp.Translations.mayWrite()).toBe(false);
    });

    it('a session whose only payload is cached holds the decision unknown, and registers its miss once the API answers true', async () => {
        const cached = { __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__', Hello: 'Bonjour' } };
        const { start, authorize, catalog, posted, t, writeEnabled } = await page({ 'langsys:translations:p1:fr-fr': JSON.stringify(cached) });
        const done = start();
        expect(t('Hello')).toBe('Bonjour');
        t('Fresh');
        await vi.advanceTimersByTimeAsync(5_000);
        expect(writeEnabled.get()).toBeUndefined();
        expect(posted).toEqual([]);

        authorize.resolve({ status: true, data: { key_type: 'write', write_enabled: true } });
        catalog.resolve({ ...CATALOG_WRITABLE, data: { __uncategorized__: { Hello: 'Bonjour' } } });
        await done;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual(['Fresh']);
    });
});
