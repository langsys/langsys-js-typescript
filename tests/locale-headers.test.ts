import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localeHeaders } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope } from '../src/request-scope.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale } from '../src/stores.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, until } from './helpers/sdk-session.js';

/**
 * FRM-6: a browser SDK supplies the header that asks the app's own API for the
 * user's language, so an API answering per the negotiated language (FRM-5) answers
 * in the language the user chose rather than the browser's default.
 */

let fx: ContractFixture;
const SEED = {
    projects: [{ id: 'p1', base_locale: 'en', target_locales: ['es-es', 'de-de'], website_url: 'https://site.local', phrases: [] }],
    keys: [{ key: 'k-read', project: 'p1', type: 'read' }],
};

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    installBrowser();
    for (const m of ['log', 'info', 'warn', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    await fx.seed(SEED);
    resetSdk();
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('FRM-6: the locale request header', () => {
    it('names the locale the user switched to, in canonical form', async () => {
        const store = createSignal('de-DE');
        await LangsysApp.init({ projectid: 'p1', key: 'k-read', UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });
        await until(() => currentlyLoadedLocale.get() === 'de-de');
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'de-de' });
        store.set('es-ES');
        // The user's choice, at once: the header does not wait for the catalog.
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'es-es' });
        expect(LangsysApp.localeHeaders()).toEqual({ 'Accept-Language': 'es-es' });
    });

    it('inside a request scope, names the scope’s locale', async () => {
        const store = createSignal('de-de');
        await LangsysApp.init({ projectid: 'p1', key: 'k-read', UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });
        const scope = await createRequestScope({ locale: 'it-IT', catalog: {} as never });
        expect(scope.run(() => localeHeaders())).toEqual({ 'Accept-Language': 'it-it' });
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'de-de' });
    });
});
