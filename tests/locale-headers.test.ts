import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { localeHeaders } from '../src/index.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope } from '../src/request-scope.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale } from '../src/stores.js';
import seeds from './contract-seeds/locale-headers.js';
import type { World } from './contract-seeds/worlds.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, until } from './helpers/sdk-session.js';

/**
 * FRM-6: a browser SDK supplies the header that asks the app's own API for the
 * user's language, so an API answering per the negotiated language (FRM-5) answers
 * in the language the user chose rather than the browser's default. Each case takes a world of its
 * own from tests/contract-seeds/locale-headers.ts.
 */

let fx: ContractFixture;
let w: World;
const init = (store: ReturnType<typeof createSignal<string>>) =>
    LangsysApp.init({ projectid: w.project(), key: w.key('k-read'), UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });

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
    w = seeds.take('base');
    await fx.use(w);
    resetSdk();
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('FRM-6: the locale request header', () => {
    it('names the locale the user switched to, in canonical form', async () => {
        const store = createSignal('de-DE');
        await init(store);
        await until(() => currentlyLoadedLocale.get() === 'de-de');
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'de-de' });
        store.set('es-ES');
        // The user's choice, at once: the header does not wait for the catalog.
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'es-es' });
        expect(LangsysApp.localeHeaders()).toEqual({ 'Accept-Language': 'es-es' });
    });

    it('inside a request scope, names the scope’s locale', async () => {
        const store = createSignal('de-de');
        await init(store);
        const scope = await createRequestScope({ locale: 'it-IT', catalog: {} as never });
        expect(scope.run(() => localeHeaders())).toEqual({ 'Accept-Language': 'it-it' });
        expect(localeHeaders()).toEqual({ 'Accept-Language': 'de-de' });
    });
});
