import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';

/**
 * The in-process double's own tests (spec CONF-2). The forwarder answers a seed's crafted
 * reference lists from it, since a clone's shared tables cannot hold a list per test, so what
 * it answers there is pinned here, with how it starts and that it offers no request log.
 */

let fx: ContractFixture;

const BASE_SEED = {
    config: { renderer_egress_ips: ['10.9.9.9'], batch_limit: 3, hint_rate_per_minute: 50 },
    projects: [
        {
            id: 'p1',
            base_locale: 'en-us',
            target_locales: ['es-es'],
            website_url: 'https://www.site.local',
            phrases: [{ category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } }],
        },
        { id: 'p2', target_locales: ['fr-fr'], website_url: 'https://other.local' },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-read', project: 'p1', type: 'read', report_discovered_content: true },
        // The canonical public site: read-only here, permitted to report.
        { key: 'k-public', project: 'p1', type: 'ip_write', report_discovered_content: true },
        { key: 'k-ipw-local', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.0/8'] },
        // May report AND may write from here: the only reason to decline its hint is that
        // the caller can write, which is what isolates that check (GATE-6's server side).
        { key: 'k-writer-reporter', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1'], report_discovered_content: true },
        { key: 'k-grant', project: 'p1', type: 'read', write_grant_secret: 'grant-secret-of-at-least-32-bytes' },
        { key: 'k-other', project: 'p2', type: 'write' },
        { key: 'k-orphan', project: null, type: 'write' },
    ],
};

type Call = { key?: string; grant?: string; method?: string; body?: unknown };
async function api(path: string, call: Call = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (call.key) headers['x-authorization'] = call.key;
    if (call.grant) headers['x-write-grant'] = call.grant;
    const res = await fetch(fx.baseUrl + path, {
        method: call.method ?? (call.body === undefined ? 'GET' : 'POST'),
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const register = (key: string, items: unknown[], project = 'p1') =>
    api('/translatable-items', { key, body: { project_id: project, translatable_items: items } });
const phrase = (text: string, category: string | null = 'UI') => ({ type: 'phrase', phrase: text, category });
const hint = (key: string | undefined, url: string) => api('/discovery/hint', { key, body: { page_url: url } });

beforeAll(async () => {
    fx = await startContractFixture({}, { double: true });
});
afterAll(async () => {
    await fx.stop();
});
beforeEach(async () => {
    await fx.seed(BASE_SEED);
});

describe('it starts the way the README says', () => {
    it('reports an /api base URL on 127.0.0.1', () => {
        expect(fx.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);
    });
});

describe('the reference lists, as LocaleController, CountryController and CurrencyController answer them', () => {
    // The organisation's code format is per project; p1 targets es-es and p2 fr-fr.
    const REFERENCE = {
        locales: ['fr-fr', 'es-es', 'es-cr', 'en-us'],
        countries: [{ code: 'ES' }, { code: 'CR' }, { code: 'US' }],
        dial_codes: [{ country_code: 'ES', dial_code: '34' }, { country_code: 'CR', dial_code: '506' }],
        currencies: [
            { code: 'EUR', name: 'Euro (stored)', symbol: '€' },
            { code: 'CRC', name: 'Colón (stored)', symbol: '₡' },
            // A code ICU has no entry for, so Symfony Intl throws and the stored name is kept.
            { code: 'XYZ', name: 'Test currency (stored)', symbol: 'X' },
        ],
    };
    const seedWith = (format = 'lowercase-hyphen', reference: unknown = REFERENCE) =>
        fx.seed({ ...BASE_SEED, projects: BASE_SEED.projects.map((p) => (p.id === 'p2' ? { ...p, locale_code_format: format } : p)), reference });
    const code = (res: { body: { error: { code: string } } }) => res.body.error.code;
    const keysOf = (res: { body: { data: unknown } }) => (Array.isArray(res.body.data) ? res.body.data : Object.keys(res.body.data as object));
    const flat = (query: string, key = 'k-other') => api(`/locales/flat?${query}`, { key });
    const q = (locale: string, extra = '') => `locales%5B%5D=${locale}${extra}`;

    it('no key is 401, an unknown key 403, on every reference route; a real key reads', async () => {
        await seedWith();
        for (const path of ['/locales', '/locales/flat', '/locales/data', '/countries/es-es', '/countries/dial-codes/es-es', '/currencies/es-es']) {
            expect(code(await api(path)), path).toBe('unauthenticated');
            expect(code(await api(path, { key: 'k-unknown' })), path).toBe('api_key_invalid');
            expect((await api(path, { key: 'k-read' })).status, path).toBe(200);
        }
    });

    it('a display locale appends the key’s target locales unless append_target_locales is false', async () => {
        await seedWith();
        expect(keysOf(await flat(q('es-es')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=1')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=true')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=false')))).toEqual(['es-es']);
    });

    it('locales/data names the requested locales in the table’s order, so an appended one can come first', async () => {
        await seedWith();
        expect(keysOf(await api(`/locales/data?${q('es-es')}`, { key: 'k-other' }))).toEqual(['fr-fr', 'es-es']);
        expect(keysOf(await api(`/locales/data?${q('es-es', '&append_target_locales=0')}`, { key: 'k-other' }))).toEqual(['es-es']);
    });

    it('a project_id appends its target locales whatever the flag, and one the key does not belong to is 403', async () => {
        await seedWith();
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0&project_id=p2')))).toEqual(['es-es', 'fr-fr']);
        expect(code(await flat(q('es-es', '&append_target_locales=0&project_id=p1')))).toBe('forbidden');
    });

    it('append_target_locales other than true, false, 1 or 0, and locales that is not a list, are 422', async () => {
        await seedWith();
        const res = await flat('locales=es-es&append_target_locales=yes');
        expect(res.status).toBe(422);
        expect(res.body.error.errors.map((e: { field: string; code: string }) => `${e.field} ${e.code}`)).toEqual([
            'locales invalid_type',
            'append_target_locales invalid_type',
        ]);
    });

    it('a locale the table does not hold names nothing, and an empty answer is data: []', async () => {
        await seedWith();
        expect((await flat(q('xx-yy', '&append_target_locales=0'))).body).toEqual({ status: true, data: [] });
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('request-dto-processor formats locales[] as UsesLocales::formatLocale does, `_` to `-` and lowercased', async () => {
        await seedWith();
        expect(keysOf(await flat(q('ES-ES', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es_ES', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('request-dto-processor refuses a query key LocalesIndexRequest does not declare, and accepts every one it does', async () => {
        await seedWith();
        const refused = await flat(q('es-es', '&append_target_locales=0&format=flat'));
        expect(refused.status).toBe(422);
        expect(refused.body.error.errors).toEqual([{ field: 'format', code: 'not_allowed', message: 'This field is not allowed.', template: 'This field is not allowed.' }]);
        expect((await flat(q('es-es', '&append_target_locales=0&user_locale=es-es&project_id=p2'))).status).toBe(200);
        const two = await flat(q('es-es', '&zeta=1&alpha=1'));
        expect(two.body.error.errors.map((e: { field: string }) => e.field)).toEqual(['zeta', 'alpha']);
    });

    it('request-dto-processor runs after the API-key check and before the usage balance', async () => {
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, keys: [...BASE_SEED.keys, { key: 'k-spent', project: 'p1', type: 'read', usage_exhausted: true }] });
        expect(code(await flat(q('es-es', '&format=x'), 'k-unknown'))).toBe('api_key_invalid');
        expect(code(await flat(q('es-es', '&format=x'), 'k-spent'))).toBe('validation_failed');
        expect(code(await flat(q('es-es'), 'k-spent'))).toBe('api_units_limit_exceeded');
    });

    it('query keys are read as PHP parses them: a bracketed key by its name, dots and spaces in a name as underscores', async () => {
        await seedWith();
        expect(keysOf(await flat('locales%5Ba%5D=es-es&append.target_locales=0'))).toEqual(['es-es']);
        const refused = await flat(q('es-es', '&foo%5Bbar%5D=1'));
        expect(refused.body.error.errors.map((e: { field: string }) => e.field)).toEqual(['foo']);
    });

    it('query keys are read as PHP parses them: leading spaces dropped, a key with no name dropped, the last key deciding the shape of locales', async () => {
        await seedWith();
        const fields = (res: { body: { error: { errors: { field: string }[] } } }) => res.body.error.errors.map((e) => e.field);
        expect(keysOf(await flat(`%20${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        // A name with a space inside is still a field of its own, and undeclared.
        expect(fields(await flat(`lo%20cales%5B%5D=es-es&append_target_locales=0`))).toEqual(['lo_cales']);
        expect(keysOf(await flat(`%5Bx%5D=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(fields(await flat(`x%5B%5D=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['x']);
        expect(keysOf(await flat(`locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        const scalar = await flat(`${q('es-es')}&locales=x&append_target_locales=0`);
        expect(scalar.body.error.errors).toEqual([expect.objectContaining({ field: 'locales', code: 'invalid_type' })]);
        expect(keysOf(await flat(`${q('fr-fr')}&locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        // A key with no name at all is dropped too, as one with a name is not.
        expect(keysOf(await flat(`=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(fields(await flat(`x=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['x']);
    });

    it('a locales index is a key, as PHP keys an array: a repeated index keeps its last value, and an empty locales is none', async () => {
        await seedWith();
        const at = (index: string, locale: string) => `locales%5B${index}%5D=${locale}`;
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('a', 'fr-fr')}&${at('a', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        // Two indexes keep two values; the table orders them.
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('1', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        expect(keysOf(await flat(`${at('5', 'fr-fr')}&${at('', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        // An empty locales is null after ConvertEmptyStringsToNull, so it asks for none.
        for (const empty of ['locales=', 'locales', 'locales=%20', `${q('es-es')}&locales=`]) {
            const res = await flat(`${empty}&append_target_locales=0`);
            expect(res.status, empty).toBe(200);
            expect(keysOf(res), empty).toEqual([]);
        }
        expect((await flat('locales=x&append_target_locales=0')).status).toBe(422);
    });

    it('each display locale names the lists in its own language, with the organisation’s code format on keys and codes', async () => {
        await seedWith('posix');
        const es = (await flat(q('es-es', '&append_target_locales=0'))).body.data;
        expect(Object.keys(es)).toEqual(['es_ES']);
        expect(es.es_ES).toContainEqual({ code: 'es_CR', name: 'Español (Costa Rica)' });
        const fr = (await flat(q('fr-fr', '&append_target_locales=0'))).body.data;
        expect(fr.fr_FR).toContainEqual({ code: 'es_CR', name: 'Espagnol (Costa Rica)' });
        await seedWith('bcp47');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-ES']);
        await seedWith('lowercase-hyphen');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-es']);
    });

    it('the grouped form groups by language name, and the data form carries both names', async () => {
        await seedWith();
        const grouped = (await api(`/locales?${q('en-us', '&append_target_locales=0')}`, { key: 'k-read' })).body.data['en-us'];
        expect(Object.keys(grouped)).toEqual(['English', 'French', 'Spanish']);
        expect(grouped.Spanish).toEqual([
            { code: 'es-cr', name: 'Spanish (Costa Rica)' },
            { code: 'es-es', name: 'Spanish (Spain)' },
        ]);
        const data = (await api(`/locales/data?${q('en-us', '&append_target_locales=0')}`, { key: 'k-read' })).body.data['en-us'];
        expect(data).toContainEqual({ code: 'es-es', locale_name: 'Spanish (Spain)', lang_name: 'Spanish' });
    });

    it('countries, dial codes and currencies are the list itself, named in the display locale; codes stay as stored', async () => {
        await seedWith('posix');
        const countries = (await api('/countries/es-es', { key: 'k-other' })).body;
        expect(countries).toEqual({
            status: true,
            data: [
                { label: 'Costa Rica', code: 'CR', eu: false },
                { label: 'España', code: 'ES', eu: true },
                { label: 'Estados Unidos', code: 'US', eu: false },
            ],
        });
        expect((await api('/countries/en-us', { key: 'k-other' })).body.data.map((c: { label: string }) => c.label)).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await api('/countries/dial-codes/fr-fr', { key: 'k-other' })).body.data).toEqual([
            { country_code: 'CR', dial_code: '506', name: 'Costa Rica (+506)' },
            { country_code: 'ES', dial_code: '34', name: 'Espagne (+34)' },
        ]);
        expect((await api('/currencies/es-es', { key: 'k-other' })).body.data.map((c: { name: string }) => c.name)).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
    });

    it('edge display locales are named as the backend names them: root and und by code, an underscore read as a hyphen, Symfony’s currency chain', async () => {
        await seedWith();
        const labels = async (locale: string) => (await api(`/countries/${locale}`, { key: 'k-read' })).body.data.map((c: { label: string }) => c.label);
        const currencies = async (locale: string) => (await api(`/currencies/${locale}`, { key: 'k-read' })).body.data.map((c: { name: string }) => c.name);
        expect(await labels('es_ES')).toEqual(['Costa Rica', 'España', 'Estados Unidos']);
        expect(await labels('root')).toEqual(['CR', 'ES', 'US']);
        expect(await labels('und')).toEqual(['CR', 'ES', 'US']);
        // Symfony's root bundle names a few currencies, EUR among them, by code; for the rest it throws.
        expect(await currencies('root')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        expect(await labels('root_ES')).toEqual(['CR', 'ES', 'US']);
        expect(await currencies('root_ES')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        // und with a region has no language: ICU names it in the host's default, and Symfony throws.
        expect(await labels('und_ES')).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect(await currencies('und_ES')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        // Symfony's fallback chain ends for a one-subtag locale of four or more letters, and for und.
        expect(await currencies('abcd')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await currencies('und')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await currencies('es_ES')).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
    });

    it('a currency is named from the first Symfony bundle on the display locale’s chain that holds it, its locale matched by case as on the backend’s Linux hosts', async () => {
        await seedWith();
        const currencies = async (locale: string) => (await api(`/currencies/${locale}`, { key: 'k-read' })).body.data.map((c: { name: string }) => c.name);
        const named = (locale: string) => ['EUR', 'CRC'].map((code) => new Intl.DisplayNames([locale], { type: 'currency' }).of(code));
        const stored = 'Test currency (stored)';
        // zh_tw has neither a bundle nor an alias (Symfony's is zh_TW), so it falls back to zh,
        // Simplified; zh_TW's alias, and zh_hant_tw's fallback, reach zh_Hant, Traditional.
        expect(named('zh')).not.toEqual(named('zh-Hant'));
        expect(await currencies('zh-tw')).toEqual([...named('zh'), stored]);
        expect(await currencies('zh_TW')).toEqual([...named('zh-Hant'), stored]);
        expect(await currencies('zh-hant-tw')).toEqual([...named('zh-Hant'), stored]);
        // pt_pt drops its region to pt; sr_latn_ba drops to sr_Latn, and sr_ba to sr.
        expect(named('pt')).not.toEqual(named('pt-PT'));
        expect(await currencies('pt-pt')).toEqual([...named('pt'), stored]);
        expect(await currencies('sr-latn-ba')).toEqual([...named('sr-Latn'), stored]);
        expect(await currencies('sr-ba')).toEqual([...named('sr'), stored]);
        // nb has no bundle, and tl's alias fil none: both fall back to en. iw's alias he has one.
        expect(await currencies('nb')).toEqual([...named('en'), stored]);
        expect(await currencies('tl')).toEqual([...named('en'), stored]);
        expect(await currencies('iw-il')).toEqual([...named('he'), stored]);
        // hi_latn_in drops its region to hi_Latn, whose bundle holds CRC and not EUR, so EUR is
        // named further along, in hi; hi_latn drops its script straight to hi.
        expect(await currencies('hi-latn-in')).toEqual([named('hi')[0], named('hi-Latn')[1], stored]);
        expect(await currencies('hi-latn')).toEqual([...named('hi'), stored]);
    });

    it('a display locale of und with two subtags more fails as the backend fails: Symfony throws a ValueError the controller does not catch', async () => {
        await seedWith();
        const res = await api('/currencies/und-latn-es', { key: 'k-read' });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('internal_error');
        expect((await api('/countries/und-latn-es', { key: 'k-read' })).status).toBe(200);
        // With one subtag more, Symfony throws a MissingResourceException, which keeps the stored names.
        expect((await api('/currencies/und-es', { key: 'k-read' })).body.data.map((c: { name: string }) => c.name)).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
    });

    it('a display locale ICU has no data for is named in English, its fallback; a currency ICU cannot name keeps its stored name', async () => {
        await seedWith();
        expect((await api('/currencies/xx-yy', { key: 'k-read' })).body.data.map((c: { name: string }) => c.name)).toEqual(['Euro', 'Costa Rican Colón', 'Test currency (stored)']);
        expect((await api('/countries/xx-yy', { key: 'k-read' })).body.data.map((c: { label: string }) => c.label)).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await flat(q('en-us', '&append_target_locales=0'))).body.data['en-us']).toContainEqual({ code: 'es-cr', name: 'Spanish (Costa Rica)' });
    });

    it('the lists are state: a reseeded table answers the new rows', async () => {
        await seedWith();
        expect((await api('/countries/en-us', { key: 'k-read' })).body.data).toHaveLength(3);
        await seedWith('lowercase-hyphen', { ...REFERENCE, countries: [{ code: 'FR' }] });
        expect((await api('/countries/en-us', { key: 'k-read' })).body.data).toEqual([{ label: 'France', code: 'FR', eu: true }]);
    });

    it('the deprecated locales/{locale}/{format} is not served, and a reference route takes GET only', async () => {
        await seedWith();
        expect(code(await api('/locales/es-es/data', { key: 'k-read' }))).toBe('not_found');
        expect(code(await api('/countries/es-es', { key: 'k-write', method: 'POST' }))).toBe('method_not_allowed');
        expect(code(await api('/locales', { key: 'k-write', method: 'POST' }))).toBe('method_not_allowed');
    });

    it('an exhausted balance is 402 on a reference route, and a suspended project refuses it', async () => {
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, keys: [...BASE_SEED.keys, { key: 'k-spent', project: 'p1', type: 'read', usage_exhausted: true }] });
        expect(code(await api('/countries/es-es', { key: 'k-spent' }))).toBe('api_units_limit_exceeded');
        expect((await api('/countries/es-es', { key: 'k-read' })).status).toBe(200);
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, projects: BASE_SEED.projects.map((p) => (p.id === 'p1' ? { ...p, subscription_suspended: true } : p)) });
        expect(code(await api('/locales/flat?locales%5B%5D=es-es', { key: 'k-read' }))).toBe('project_unavailable');
    });

    it('a seed with a locale code format it does not know is refused', async () => {
        const res = await fetch(fx.fixtureUrl + '/seed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projects: [{ id: 'p9', locale_code_format: 'upper' }] }),
        });
        expect(res.status).toBe(400);
    });
});

describe('the reference lists name an unknown display locale in English whatever the host’s locale', () => {
    // ICU's own fallback for a display locale it has no data for is the host's default locale.
    const SPANISH_HOST = { LANG: 'es_ES.UTF-8', LC_ALL: 'es_ES.UTF-8' };
    let spanish: ContractFixture;
    beforeAll(async () => {
        spanish = await startContractFixture(SPANISH_HOST, { double: true });
    });
    afterAll(async () => {
        await spanish.stop();
    });

    it('control: on that host, ICU’s own fallback is Spanish', () => {
        const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(new Intl.DisplayNames(['zz'], { type: 'currency' }).of('EUR'))"], {
            env: { ...process.env, ...SPANISH_HOST },
            encoding: 'utf8',
        });
        expect(probe.stdout).toBe('euro');
    });

    it('a double on a Spanish host answers xx-yy in English, as a backend host whose ICU default is English does', async () => {
        await spanish.seed({
            projects: [{ id: 'p1' }],
            keys: [{ key: 'k1', project: 'p1', type: 'read' }],
            reference: { countries: [{ code: 'ES' }], currencies: [{ code: 'EUR', name: 'Euro (stored)' }] },
        });
        const read = async (path: string) => (await (await fetch(spanish.baseUrl + path, { headers: { 'x-authorization': 'k1' } })).json()).data;
        expect((await read('/currencies/xx-yy')).map((c: { name: string }) => c.name)).toEqual(['Euro']);
        expect((await read('/countries/xx-yy')).map((c: { label: string }) => c.label)).toEqual(['Spain']);
        expect((await read('/currencies/es-es')).map((c: { name: string }) => c.name)).toEqual(['euro']);
    });
});

describe('there is no request log', () => {
    it('state carries accepted state only, and no route returns what was received', async () => {
        await register('k-read', [phrase('Refused')]);
        await hint('k-write', 'https://site.local/declined');
        const state = await fx.state();
        expect(Object.keys(state).sort()).toEqual(['hints', 'projects']);
        expect(JSON.stringify(state)).not.toContain('Refused');
        expect(JSON.stringify(state)).not.toContain('declined');
        for (const route of ['/requests', '/log', '/history', '/calls']) {
            expect((await fetch(fx.fixtureUrl + route)).status, route).toBe(404);
        }
    });
});
