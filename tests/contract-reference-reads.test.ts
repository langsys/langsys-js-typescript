import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysConfigurationError } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createRequestScope } from '../src/request-scope.js';
import { createSignal } from '../src/signal.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, session as startSession, sleep } from './helpers/sdk-session.js';

/**
 * REF-1, graded against the contract double (spec CONF-2, tier `contract`): the core serves
 * the API's reference lists on `LangsysApp`, one call per list, each in a display locale that
 * defaults to the current one.
 *
 * The double names every list in the display locale through ICU, as the backend does, so each
 * display locale answers a distinct list, and every assertion is on which list came back. A
 * call that must not send is shown by capability drift: the double is reseeded so that a read
 * would answer a different list, and the call still answers the one it held. Where the double
 * cannot see the request at all (a refused display locale, an unconfigured core), the absence
 * is counted at the transport seam, `fetch`.
 */

let fx: ContractFixture;

const REFERENCE = {
    // en-us-posix is in the API's Locale table: WIRE-3's form keeps it as the API stores it.
    // he-il is what the core's current locale is for a store holding the legacy alias iw-IL.
    locales: ['fr-fr', 'es-es', 'es-cr', 'en-us', 'de-de', 'en-us-posix', 'he-il'],
    countries: [{ code: 'ES' }, { code: 'CR' }, { code: 'US' }],
    dial_codes: [{ country_code: 'ES', dial_code: '34' }, { country_code: 'CR', dial_code: '506' }],
    currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }, { code: 'CRC', name: 'Costa Rican Colón', symbol: '₡' }],
};
/** A second set of tables, so that a read made after a reseed answers a different list. */
const RESEEDED = {
    locales: ['it-it', 'es-es', 'en-us', 'fr-fr', 'de-de'],
    countries: [{ code: 'IT' }],
    dial_codes: [{ country_code: 'IT', dial_code: '39' }],
    currencies: [{ code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' }],
};

const seed = (reference: unknown = REFERENCE, extra: { format?: string; faults?: unknown[]; keys?: unknown[]; projects?: unknown[] } = {}) => ({
    projects: [{ id: 'p1', base_locale: 'en-us', target_locales: ['fr-fr'], locale_code_format: extra.format ?? 'lowercase-hyphen' }, ...(extra.projects ?? [])],
    keys: [{ key: 'k1', project: 'p1', type: 'read' }, ...(extra.keys ?? [])],
    reference,
    faults: extra.faults ?? [],
});

type Call = (locale?: string) => Promise<unknown>;
const LISTS: { name: string; route: string; call: Call; empty: unknown }[] = [
    { name: 'getLocales', route: 'locales', call: (l) => LangsysApp.getLocales(l), empty: {} },
    { name: 'getLocalesFlat', route: 'locales/flat', call: (l) => LangsysApp.getLocalesFlat(l), empty: [] },
    { name: 'getLocalesData', route: 'locales/data', call: (l) => LangsysApp.getLocalesData(l), empty: [] },
    { name: 'getCurrencies', route: 'currencies', call: (l) => LangsysApp.getCurrencies(l), empty: [] },
    { name: 'getCountries', route: 'countries', call: (l) => LangsysApp.getCountries(l), empty: [] },
    { name: 'getDialCodes', route: 'countries/dial-codes', call: (l) => LangsysApp.getDialCodes(l), empty: [] },
];
const LOCALE_FORMS = LISTS.filter((l) => l.route.startsWith('locales'));

/** WIRE-3's form of a locale code, which every locale form answers its codes in. */
const wire3 = (code: string) => code.replace(/_/g, '-').toLowerCase();
function wire3Codes(list: unknown): unknown {
    if (Array.isArray(list)) return list.map((row) => ({ ...row, code: wire3(row.code) }));
    return Object.fromEntries(Object.entries(list as Record<string, unknown>).map(([group, rows]) => [group, wire3Codes(rows)]));
}

/** The list the double answers for `locale` right now, read from it directly under the session's key. */
async function doubleList(route: string, locale: string, key = 'k1'): Promise<unknown> {
    const byLocale = route.startsWith('locales');
    const url = byLocale ? `${fx.baseUrl}/${route}?locales%5B%5D=${locale}&append_target_locales=0` : `${fx.baseUrl}/${route}/${locale}`;
    const body = await (await fetch(url, { headers: { 'x-authorization': key } })).json();
    if (!byLocale) return body.data;
    const [, entry] = Object.entries(body.data).find(([k]) => wire3(k) === locale) ?? [];
    return entry === undefined ? undefined : wire3Codes(entry);
}

/** A configured core whose current locale is es-es. */
const configured = (key = 'k1') => startSession(fx.baseUrl, key, { locale: 'es-es' });

/** Every request the core sends from here on, at the transport seam. */
function countRequests(): string[] {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        sent.push(String(input));
        return real(input as string, init);
    });
    return sent;
}

let errors: ReturnType<typeof vi.spyOn>;
const logged = () => errors.mock.calls.flat().map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
/** The lines a console method was called with that mention `text`, each as one string. */
const linesWith = (calls: unknown[][], text: string) =>
    calls.map((call) => call.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')).filter((line) => line.includes(text));

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    for (const m of ['log', 'info', 'group', 'groupCollapsed', 'groupEnd', 'warn'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fx.seed(seed());
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe.each(LISTS)('REF-1 against the contract double: $name', ({ name, route, call, empty }) => {
    it('control: a configured core answers the double’s list for the display locale, and each locale’s list is its own', async () => {
        await configured();
        const es = await call('es-es');
        expect(es).toEqual(await doubleList(route, 'es-es'));
        expect(es).not.toEqual(empty);
        expect(es).not.toEqual(await doubleList(route, 'en-us'));
    });

    it('with no locale it answers the current locale’s list, and with one that locale’s, read in WIRE-3’s form', async () => {
        await configured();
        expect(await call()).toEqual(await doubleList(route, 'es-es'));
        expect(await call('en_US')).toEqual(await doubleList(route, 'en-us'));
    });

    it('with no locale it answers the locale the core serves, as t() does, on both profiles: a store or scope holding iw-IL answers he-il', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: 'k1', UserLocaleStore: createSignal('iw-IL'), baseLocale: 'en', apiUrl: fx.baseUrl });
        expect(await call()).toEqual(await doubleList(route, 'he-il'));
        const scope = await createRequestScope({ locale: 'iw_IL' });
        expect(await scope.run(() => call())).toEqual(await doubleList(route, 'he-il'));
    });

    it('with no locale, a store or scope holding en-US-POSIX answers en-us-posix, the code the API holds', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: 'k1', UserLocaleStore: createSignal('en-US-POSIX'), baseLocale: 'en', apiUrl: fx.baseUrl });
        const posix = await doubleList(route, 'en-us-posix');
        expect(posix).not.toEqual(empty);
        expect(await call()).toEqual(posix);
        const scope = await createRequestScope({ locale: 'en_US_POSIX' });
        expect(await scope.run(() => call())).toEqual(posix);
    });

    it('two callers sharing one read each get their own copy', async () => {
        await configured();
        const [a, b] = (await Promise.all([call('fr-fr'), call('fr-fr')])) as (unknown[] | Record<string, unknown[]>)[];
        for (const answered of [a, b]) {
            if (Array.isArray(answered)) answered.length = 0;
            else for (const group of Object.keys(answered)) delete answered[group];
        }
        expect(await call('fr-fr')).toEqual(await doubleList(route, 'fr-fr'));
    });

    it('a list is held per display locale: the same locale again sends nothing, another locale reads, and the first is still held', async () => {
        await configured();
        const first = await call('es-es');
        await fx.seed(seed(RESEEDED));
        const now = await doubleList(route, 'es-es');
        expect(now).not.toEqual(first);
        expect(await call('es-es')).toEqual(first);
        expect(await call('en-us')).toEqual(await doubleList(route, 'en-us'));
        expect(await call('es-es')).toEqual(first);
        expect(await call('en-us')).toEqual(await doubleList(route, 'en-us'));
    });

    it.each(['../projects', 'es/es', 'es?x=1', 'es-es#x', '%2e%2e', 'es es', ' es-es', 'es-es '])('a display locale shaped as %j sends nothing, answers the empty value and warns', async (bad) => {
        await configured();
        const sent = countRequests();
        expect(await call(bad)).toEqual(empty);
        expect(sent).toEqual([]);
        expect(linesWith(vi.mocked(console.warn).mock.calls, `LangsysApp.${name}: "${wire3(bad)}" is not a locale`)).toHaveLength(1);
    });

    it.each([
        ['an error status', { status: 500 }, 'HTTP 500'],
        ['a dropped connection', { drop: true }, 'Error communicating with API Server'],
        ['an answer that is not of the list’s shape', { body: JSON.stringify({ status: true, data: route.startsWith('locales') ? { 'fr-fr': { Spanish: 'not a list' } } : { ES: 'Spain' } }) }, "is not of the list's shape"],
        ['an answer that is not JSON', { body: '<html>gateway</html>', content_type: 'text/html' }, 'is not valid JSON'],
    ])('with %s it answers the empty value and logs the cause; inside the window it sends nothing, and after it reads', async (_, fault, cause) => {
        const path = route.startsWith('locales') ? `/${route}` : `/${route}/fr-fr`;
        // After init(), whose own read of the current locale's data would take the fault.
        await configured();
        await fx.seed(seed(REFERENCE, { faults: [{ method: 'GET', path, ...fault }] }));
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        expect(await call('fr-fr')).toEqual(empty);
        // The core's own line names the call, the list, the display locale and the cause.
        const said = linesWith(errors.mock.calls, `LangsysApp.${name}`);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(`${route} (fr-fr)`);
        expect(said[0]).toContain(cause);
        // The fault is spent, so a read now would answer the list: the window sends none.
        expect(await call('fr-fr')).toEqual(empty);
        vi.setSystemTime(Date.now() + 3_001);
        expect(await call('fr-fr')).toEqual(await doubleList(route, 'fr-fr'));
    });

    it('a failure is never held as a list: a second failure widens the window, and the read after it answers', async () => {
        const path = route.startsWith('locales') ? `/${route}` : `/${route}/fr-fr`;
        await configured();
        await fx.seed(seed(REFERENCE, { faults: [{ method: 'GET', path, status: 503, times: 2 }] }));
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        expect(await call('fr-fr')).toEqual(empty);
        vi.setSystemTime(Date.now() + 3_001);
        expect(await call('fr-fr')).toEqual(empty);
        vi.setSystemTime(Date.now() + 3_001);
        expect(await call('fr-fr')).toEqual(empty);
        vi.setSystemTime(Date.now() + 3_000);
        expect(await call('fr-fr')).toEqual(await doubleList(route, 'fr-fr'));
    });

    it('unconfigured, it sends nothing, answers the empty value, and logs nothing of its own', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        const sent = countRequests();
        const said = vi.mocked(console.warn).mock.calls.length + errors.mock.calls.length;
        expect(await call()).toEqual(empty);
        expect(await call('en-us')).toEqual(empty);
        expect(sent).toEqual([]);
        expect(vi.mocked(console.warn).mock.calls.length + errors.mock.calls.length).toBe(said);
    });

    it('unconfigured with requireCredentials, it throws the configuration error, as any first use does', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
        const sent = countRequests();
        await expect(call('es-es')).rejects.toBeInstanceOf(LangsysConfigurationError);
        expect(sent).toEqual([]);
    });

    it('what a caller does to an answered list does not change what the next caller gets', async () => {
        await configured();
        const first = (await call('es-es')) as unknown[] | Record<string, unknown[]>;
        if (Array.isArray(first)) {
            first.unshift({ code: 'zz', label: 'Placeholder', name: 'Placeholder' });
            (first[1] as Record<string, unknown>).code = 'changed';
        } else {
            first.Placeholder = [];
            Object.values(first)[0]!.length = 0;
        }
        expect(await call('es-es')).toEqual(await doubleList(route, 'es-es'));
    });

    it('unconfigured, a list a configured session held is not answered: the empty value, or the configuration error under requireCredentials', async () => {
        await configured();
        expect(await call('es-es')).toEqual(await doubleList(route, 'es-es'));
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        expect(await call('es-es')).toEqual(empty);
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
        await expect(call('es-es')).rejects.toBeInstanceOf(LangsysConfigurationError);
    });

    it('unconfigured, a display locale not shaped as one is still the configuration question: silent without requireCredentials, the error with it', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        const said = vi.mocked(console.warn).mock.calls.length + errors.mock.calls.length;
        expect(await call('../projects')).toEqual(empty);
        expect(vi.mocked(console.warn).mock.calls.length + errors.mock.calls.length).toBe(said);
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
        await expect(call('../projects')).rejects.toBeInstanceOf(LangsysConfigurationError);
    });

    it('under requireCredentials with the module unconfigured, a request scope with credentials of its own answers the list', async () => {
        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
        const scope = await createRequestScope({ locale: 'de-de', credentials: { projectid: 'p1', key: 'k1' } });
        expect(await scope.run(() => call())).toEqual(await doubleList(route, 'de-de'));
    });

    it('two reads of one list and locale while the first is unanswered share one request', async () => {
        // A key whose second identical request inside the minute is refused 429.
        await fx.seed(seed(REFERENCE, { keys: [{ key: 'k-once', project: 'p1', type: 'read', duplicate_guard: { max_attempts: 1, window_seconds: 60 } }] }));
        await configured('k-once');
        const [a, b] = await Promise.all([call('fr-fr'), call('fr-fr')]);
        const list = await doubleList(route, 'fr-fr', 'k1');
        expect(a).toEqual(list);
        expect(b).toEqual(list);
        // Control: the guard refuses a second identical request from that key.
        const again = route.startsWith('locales') ? `${fx.baseUrl}/${route}?locales%5B%5D=en-us&append_target_locales=0` : `${fx.baseUrl}/${route}/en-us`;
        expect((await fetch(again, { headers: { 'x-authorization': 'k-once' } })).status).toBe(200);
        expect((await fetch(again, { headers: { 'x-authorization': 'k-once' } })).status).toBe(429);
    });

    it('on the server profile, a request scope’s current locale is the scope’s, and a second request answers the held list with no read', async () => {
        await configured();
        const first = await createRequestScope({ locale: 'de-de' });
        const held = await first.run(() => call());
        expect(held).toEqual(await doubleList(route, 'de-de'));
        await fx.seed(seed(RESEEDED));
        expect(await doubleList(route, 'de-de')).not.toEqual(held);
        const second = await createRequestScope({ locale: 'de-de' });
        expect(await second.run(() => call())).toEqual(held);
    });

    it('one hold serves every project: a request scope under another project, with its own key, answers the held list with no read', async () => {
        await configured();
        const held = await call('fr-fr');
        expect(held).toEqual(await doubleList(route, 'fr-fr'));
        await fx.seed(seed(RESEEDED, { projects: [{ id: 'p2', base_locale: 'en-us', target_locales: ['fr-fr'] }], keys: [{ key: 'k2', project: 'p2', type: 'read' }] }));
        expect(await doubleList(route, 'fr-fr', 'k2')).not.toEqual(held);
        const other = await createRequestScope({ locale: 'fr-fr', credentials: { projectid: 'p2', key: 'k2' } });
        expect(await other.run(() => call())).toEqual(held);
    });

    it('a request scope reads under its own credentials: a scope’s refused key answers empty under a configured module, and a valid one answers under an unconfigured module', async () => {
        await configured();
        const refused = await createRequestScope({ locale: 'en-us', credentials: { projectid: 'p1', key: 'k-unknown' } });
        expect(await refused.run(() => call())).toEqual(empty);
        expect(await call('en-us')).toEqual(empty);

        resetSdk();
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        const valid = await createRequestScope({ locale: 'de-de', credentials: { projectid: 'p1', key: 'k1' } });
        expect(await valid.run(() => call())).toEqual(await doubleList(route, 'de-de'));
    });
});

describe.each(LOCALE_FORMS)('REF-1 against the contract double: $name answers the display locale’s entry', ({ route, call, empty }) => {
    it.each([
        ['posix', 'es_ES'],
        ['bcp47', 'es-ES'],
    ])('an organisation whose codes are %s: the entry keyed %s is answered for es-es, with every code in WIRE-3’s form', async (format) => {
        await fx.seed(seed(REFERENCE, { format }));
        await configured();
        const list = await call('es-es');
        expect(list).toEqual(await doubleList(route, 'es-es'));
        expect(JSON.stringify(list)).toContain('"code":"es-cr"');
        expect(JSON.stringify(list)).not.toMatch(/"code":"[a-z]+[_-][A-Z]/);
    });

    it('a code is answered in WIRE-3’s form, as the API stores it: en-us-posix is listed and can be asked for', async () => {
        await fx.seed(seed(REFERENCE, { format: 'bcp47' }));
        await configured();
        expect(JSON.stringify(await call('en-us'))).toContain('"code":"en-us-posix"');
        const posix = await call('en-US-POSIX');
        expect(posix).toEqual(await doubleList(route, 'en-us-posix'));
        expect(posix).not.toEqual(empty);
    });

    it('a display locale given is asked for as written, with no alias resolved: iw-IL asks for iw-il', async () => {
        // A table holding iw-il and not he-il, so only a request for iw-il answers a list.
        await fx.seed(seed({ ...REFERENCE, locales: [...REFERENCE.locales.filter((code) => code !== 'he-il'), 'iw-il'] }));
        await configured();
        expect(await doubleList(route, 'he-il')).toBeUndefined();
        const iwIl = await doubleList(route, 'iw-il');
        expect(iwIl).not.toEqual(empty);
        expect(await call('iw-IL')).toEqual(iwIl);
    });

    it('a display locale the API does not hold answers the empty value, held like any answer', async () => {
        await configured();
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        expect(await call('xx-yy')).toEqual(empty);
        await fx.seed(seed({ ...REFERENCE, locales: [...REFERENCE.locales, 'xx-yy'] }));
        expect(await doubleList(route, 'xx-yy')).not.toEqual(empty);
        // Past any failure window: an answer held, not a failure remembered.
        vi.setSystemTime(Date.now() + 600_000);
        expect(await call('xx-yy')).toEqual(empty);
    });
});

describe.each(LISTS.filter((list) => !list.route.startsWith('locales')))('REF-1 against the contract double: $name asks for a given display locale as written', ({ route, call, empty }) => {
    it('iw-IL asks for iw-il, not he-il: with a fault on he-il’s path, it answers iw-il’s list', async () => {
        await configured();
        // ICU names a list in iw-il as it does in he-il, so only the path tells them apart.
        const iwIl = await doubleList(route, 'iw-il');
        expect(iwIl).not.toEqual(empty);
        await fx.seed(seed(REFERENCE, { faults: [{ method: 'GET', path: `/${route}/he-il`, status: 503 }] }));
        expect(await call('iw-IL')).toEqual(iwIl);
    });
});

describe('REF-1 against the contract double: what reads the held lists', () => {
    it('getCountryName, getCurrencyName and getLocaleNameWithLookup name a code in the display locale', async () => {
        await configured();
        type Row = { code: string; label?: string; name?: string; locale_name?: string; lang_name?: string };
        const row = async (route: string, locale: string, code: string) =>
            ((await doubleList(route, locale)) as Row[]).find((r) => r.code.toLowerCase() === code)!;
        expect(await LangsysApp.getCountryName('es')).toBe((await row('countries', 'es-es', 'es')).label);
        expect(await LangsysApp.getCountryName('ES', 'en-us')).toBe((await row('countries', 'en-us', 'es')).label);
        expect(await LangsysApp.getCountryName('ES', 'en-us')).not.toBe(await LangsysApp.getCountryName('ES', 'es-es'));
        expect(await LangsysApp.getCurrencyName('eur', 'fr-fr')).toBe((await row('currencies', 'fr-fr', 'eur')).name);
        const esCr = await row('locales/data', 'es-es', 'es-cr');
        expect(await LangsysApp.getLocaleNameWithLookup('es-CR')).toBe(esCr.locale_name);
        expect(LangsysApp.getLocaleName('es-cr', true)).toBe(esCr.lang_name);
        expect(await LangsysApp.getLocaleNameWithLookup('en-US-POSIX', false, 'en-us')).toBe((await row('locales/data', 'en-us', 'en-us-posix')).locale_name);
        // A legacy alias names the code the API lists for it.
        expect(await LangsysApp.getLocaleNameWithLookup('iw-IL', false, 'en-us')).toBe((await row('locales/data', 'en-us', 'he-il')).locale_name);
    });

    it('getLocaleName answers nothing once the core is unconfigured, whatever it held, and throws under requireCredentials', async () => {
        await configured();
        await LangsysApp.getLocalesData('es-es');
        expect(LangsysApp.getLocaleName('es-cr', false, 'es-es')).not.toBe('');
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
        expect(LangsysApp.getLocaleName('es-cr', false, 'es-es')).toBe('');
        await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
        expect(() => LangsysApp.getLocaleName('es-cr', false, 'es-es')).toThrow(LangsysConfigurationError);
    });

    it('the locale data init() reads is the current locale’s as the core serves it, so getLocaleName names a code with no lookup', async () => {
        resetSdk();
        const heIl = ((await doubleList('locales/data', 'he-il')) as { code: string; locale_name: string }[]).find((r) => r.code === 'he-il')!;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await LangsysApp.init({ projectid: 'p1', key: 'k1', UserLocaleStore: createSignal('iw-IL'), baseLocale: 'en', apiUrl: fx.baseUrl });
        // Nothing here reads the list: only init()'s own read can hold it.
        await vi.waitFor(() => expect(LangsysApp.getLocaleName('he-il')).toBe(heIl.locale_name), { timeout: 3000 });
    });

    it('a read an explicit refresh superseded does not overwrite what the refresh held, even when it fails', async () => {
        await configured();
        await fx.seed(seed(REFERENCE, { faults: [{ method: 'GET', path: '/locales/data', delay_ms: 400, status: 503 }] }));
        const superseded = LangsysApp.getLocalesData('fr-fr');
        await sleep(100);
        const refreshed = await LangsysApp.getLocalesData('fr-fr', true);
        expect(refreshed).toEqual(await doubleList('locales/data', 'fr-fr'));
        expect(await superseded).toEqual([]);
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual(refreshed);
    });

    it('an explicit refresh that fails again widens the window, as CACHE-2 counts every failure in a row', async () => {
        await configured();
        await fx.seed(seed(REFERENCE, { faults: [{ method: 'GET', path: '/locales/data', status: 503, times: 2 }] }));
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual([]);
        expect(await LangsysApp.getLocalesData('fr-fr', true)).toEqual([]);
        // The second failure in a row: 6 seconds, so a call 3 seconds on is still inside it.
        vi.setSystemTime(Date.now() + 3_001);
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual([]);
        vi.setSystemTime(Date.now() + 3_000);
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual(await doubleList('locales/data', 'fr-fr'));
    });

    it('the first success resets the count, as CACHE-2 does: a refresh failing after it opens the first window, not a wider one', async () => {
        await configured();
        const failing = seed(REFERENCE, { faults: [{ method: 'GET', path: '/locales/data', status: 503 }] });
        await fx.seed(failing);
        vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual([]);
        await fx.seed(seed());
        vi.setSystemTime(Date.now() + 3_001);
        const list = await LangsysApp.getLocalesData('fr-fr');
        expect(list).toEqual(await doubleList('locales/data', 'fr-fr'));
        await fx.seed(failing);
        expect(await LangsysApp.getLocalesData('fr-fr', true)).toEqual([]);
        await fx.seed(seed());
        // The first failure after a success: 3 seconds, so a call 3 seconds on reads again.
        vi.setSystemTime(Date.now() + 3_001);
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual(list);
    });

    it('the locale data init() reads for getLocaleName never rejects, when a later init() was refused under requireCredentials', async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', listener);
        try {
            resetSdk();
            const store = createSignal('es-es');
            await LangsysApp.init({ projectid: 'p1', key: 'k1', UserLocaleStore: store, baseLocale: 'en', apiUrl: fx.baseUrl });
            await LangsysApp.init({ projectid: 'p1', key: '', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl, requireCredentials: true });
            store.set('fr-fr');
            await sleep(50);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', listener);
        }
    });

    it('an explicit refresh reads again: getLocalesData(locale, true), and refresh() for the locale data', async () => {
        await configured();
        const first = await LangsysApp.getLocalesData('fr-fr');
        await fx.seed(seed(RESEEDED));
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual(first);
        const reread = await LangsysApp.getLocalesData('fr-fr', true);
        expect(reread).toEqual(await doubleList('locales/data', 'fr-fr'));
        expect(reread).not.toEqual(first);
        await fx.seed(seed(REFERENCE));
        await LangsysApp.refresh();
        expect(await LangsysApp.getLocalesData('fr-fr')).toEqual(first);
    });
});
