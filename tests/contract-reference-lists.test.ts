import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedFile, type World } from './contract-seeds/worlds.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { standInCheckout, standInClone, useStandIns } from './helpers/stand-in-clone.js';

/**
 * A case's crafted reference lists (`contract-fixture/reference-lists.mjs`, spec CONF-2), as the
 * forwarder answers them: named as LocaleController, CountryController and CurrencyController
 * name the API's own tables. The forwarder answers from them only once the clone has accepted the
 * request, so every refusal is the clone's; these cases run against a stand-in clone that accepts
 * everything, and pin what the lists hold.
 */

const stub = standInClone();
const checkout = standInCheckout();
let fx: ContractFixture;

const seeds = seedFile('reference-lists', 19, {
    case: { projects: { p1: { target_locales: ['fr-fr'] } }, keys: { k1: { project: 'p1', type: 'read' } }, count: 40 },
    // An organisation whose codes are posix.
    posix: { projects: { p1: { target_locales: ['fr-fr'], locale_code_format: 'posix' } }, keys: { k1: { project: 'p1', type: 'read' } }, count: 2 },
});
let w: World;

// The case's project targets fr-fr, which a locale list would append and only the clone holds.
const REFERENCE = {
    locales: ['fr-fr', 'es-es', 'es-cr', 'en-us'],
    countries: [{ code: 'ES' }, { code: 'CR' }, { code: 'US' }],
    dial_codes: [
        { country_code: 'ES', dial_code: '34' },
        { country_code: 'CR', dial_code: '506' },
    ],
    currencies: [
        { code: 'EUR', name: 'Euro (stored)', symbol: '€' },
        { code: 'CRC', name: 'Colón (stored)', symbol: '₡' },
        // A code ICU has no entry for, so Symfony Intl throws and the stored name is kept.
        { code: 'XYZ', name: 'Test currency (stored)', symbol: 'X' },
    ],
};
/** A case's lists, posted as given: the helper would write them in the world's own code format. */
const setup = (reference: unknown) =>
    fetch(fx.fixtureUrl + '/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: w.keys, reference }) });
async function lists(format = 'lowercase-hyphen') {
    expect((await setup({ ...REFERENCE, locale_code_format: format })).status).toBe(200);
}

async function api(path: string) {
    const res = await fetch(fx.baseUrl + path, { headers: { 'x-authorization': w.key('k1') } });
    return { status: res.status, body: await res.json() };
}
const keysOf = (res: { body: { data: unknown } }) => (Array.isArray(res.body.data) ? res.body.data : Object.keys(res.body.data as object));
const flat = (query: string) => api(`/locales/flat?${query}`);
const q = (locale: string, extra = '') => `locales%5B%5D=${locale}${extra}`;
const names = async (path: string) => (await api(path)).body.data.map((c: { name: string }) => c.name);
const labels = async (path: string) => (await api(path)).body.data.map((c: { label: string }) => c.label);

beforeAll(async () => {
    stub.seed(seeds.document);
    await stub.listen();
    useStandIns(stub, checkout);
    fx = await startContractFixture();
});
afterAll(async () => {
    await fx?.stop();
    await stub.close();
});
beforeEach(async () => {
    w = seeds.take('case');
    await fx.use(w);
    await lists();
});

describe('the locale lists, as LocaleController answers them', () => {
    it('a request that would append the project’s target locales is refused with 501, naming the route: append_target_locales absent, 1 or true, or a project_id; control: with it 0 or false, the lists answer', async () => {
        for (const [why, path] of [
            ['no flag', `/locales/flat?${q('es-es')}`],
            ['the flag 1', `/locales/flat?${q('es-es', '&append_target_locales=1')}`],
            ['the flag true', `/locales?${q('es-es', '&append_target_locales=true')}`],
            ['a project_id with the flag 0', `/locales/data?${q('es-es', `&append_target_locales=0&project_id=${w.project()}`)}`],
        ]) {
            const refused = await api(path);
            expect(refused.status, why).toBe(501);
            expect(refused.body, why).toMatchObject({ ok: false, fixture: 'unsupported', route: `GET /api${path.split('?')[0]}` });
            expect(refused.body.error, why).toMatch(/append_target_locales=0 and no project_id/);
        }
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=false')))).toEqual(['es-es']);
        expect(keysOf(await api(`/locales/data?${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
    });

    it('a locale the table does not hold names nothing, and an empty answer is data: []', async () => {
        expect((await flat(q('xx-yy', '&append_target_locales=0'))).body).toEqual({ status: true, data: [] });
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('request-dto-processor formats locales[] as UsesLocales::formatLocale does, `_` to `-` and lowercased, each value trimmed', async () => {
        expect(keysOf(await flat(q('ES-ES', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es_ES', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('%20es-es%20', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('query keys are read as PHP parses them: a bracketed key by its name, dots in a name as underscores, leading spaces dropped, a key with no name dropped', async () => {
        expect(keysOf(await flat('locales%5Ba%5D=es-es&append.target_locales=0'))).toEqual(['es-es']);
        expect(keysOf(await flat(`%20${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(keysOf(await flat(`%5Bx%5D=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(keysOf(await flat(`=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
    });

    it('the last key decides the shape of locales: a list started after a string lists, and an empty locales after a list asks for none', async () => {
        expect(keysOf(await flat(`locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${q('fr-fr')}&locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${q('es-es')}&locales=&append_target_locales=0`))).toEqual([]);
    });

    it('a locales index is a key, as PHP keys an array: a repeated index keeps its last value, and an empty locales is none', async () => {
        const at = (index: string, locale: string) => `locales%5B${index}%5D=${locale}`;
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('a', 'fr-fr')}&${at('a', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        // Two indexes keep two values; the table orders them.
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('1', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        expect(keysOf(await flat(`${at('5', 'fr-fr')}&${at('', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        // `[]` takes the index after the highest so far, so it does not replace `[0]`.
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        // An empty locales is null after ConvertEmptyStringsToNull, so it asks for none.
        for (const empty of ['locales=', 'locales', 'locales=%20']) {
            expect(keysOf(await flat(`${empty}&append_target_locales=0`)), empty).toEqual([]);
        }
    });

    it('each display locale names the lists in its own language, with the organisation’s code format on keys and codes', async () => {
        await lists('posix');
        const es = (await flat(q('es-es', '&append_target_locales=0'))).body.data;
        expect(Object.keys(es)).toEqual(['es_ES']);
        expect(es.es_ES).toContainEqual({ code: 'es_CR', name: 'Español (Costa Rica)' });
        const fr = (await flat(q('fr-fr', '&append_target_locales=0'))).body.data;
        expect(fr.fr_FR).toContainEqual({ code: 'es_CR', name: 'Espagnol (Costa Rica)' });
        await lists('bcp47');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-ES']);
        await lists('lowercase-hyphen');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-es']);
    });

    it('the grouped form groups by language name, and the data form carries both names', async () => {
        const grouped = (await api(`/locales?${q('en-us', '&append_target_locales=0')}`)).body.data['en-us'];
        expect(Object.keys(grouped)).toEqual(['English', 'French', 'Spanish']);
        expect(grouped.Spanish).toEqual([
            { code: 'es-cr', name: 'Spanish (Costa Rica)' },
            { code: 'es-es', name: 'Spanish (Spain)' },
        ]);
        const data = (await api(`/locales/data?${q('en-us', '&append_target_locales=0')}`)).body.data['en-us'];
        expect(data).toContainEqual({ code: 'es-es', locale_name: 'Spanish (Spain)', lang_name: 'Spanish' });
    });

    it('the flat form is ordered by name and the data form by locale name, not in the table’s order', async () => {
        const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);
        const byName = ['en-us', 'fr-fr', 'es-cr', 'es-es'];
        expect(REFERENCE.locales).not.toEqual(byName);
        expect(codes((await flat(q('en-us', '&append_target_locales=0'))).body.data['en-us'])).toEqual(byName);
        expect(codes((await api(`/locales/data?${q('en-us', '&append_target_locales=0')}`)).body.data['en-us'])).toEqual(byName);
    });
});

describe('the countries, dial codes and currencies, as CountryController and CurrencyController answer them', () => {
    it('each is the list itself, named in the display locale; codes stay as stored', async () => {
        await lists('posix');
        expect((await api('/countries/es-es')).body).toEqual({
            status: true,
            data: [
                { label: 'Costa Rica', code: 'CR', eu: false },
                { label: 'España', code: 'ES', eu: true },
                { label: 'Estados Unidos', code: 'US', eu: false },
            ],
        });
        expect(await labels('/countries/en-us')).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await api('/countries/dial-codes/fr-fr')).body.data).toEqual([
            { country_code: 'CR', dial_code: '506', name: 'Costa Rica (+506)' },
            { country_code: 'ES', dial_code: '34', name: 'Espagne (+34)' },
        ]);
        expect(await names('/currencies/es-es')).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
        // A currency row is the table's, with its symbols, digits and rounding as stored or by default.
        expect((await api('/currencies/es-es')).body.data[0]).toEqual({ code: 'EUR', name: 'euro', symbol: '€', symbol_native: '€', decimal_digits: 2, rounding: 0 });
    });

    it('edge display locales are named as the backend names them: root and und by code, an underscore read as a hyphen, Symfony’s currency chain', async () => {
        expect(await labels('/countries/es_ES')).toEqual(['Costa Rica', 'España', 'Estados Unidos']);
        expect(await labels('/countries/root')).toEqual(['CR', 'ES', 'US']);
        expect(await labels('/countries/und')).toEqual(['CR', 'ES', 'US']);
        // Symfony's root bundle names a few currencies, EUR among them, by code; for the rest it throws.
        expect(await names('/currencies/root')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        expect(await labels('/countries/root_ES')).toEqual(['CR', 'ES', 'US']);
        expect(await names('/currencies/root_ES')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        // und with a region has no language: ICU names it in the host's default, and Symfony throws.
        expect(await labels('/countries/und_ES')).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect(await names('/currencies/und_ES')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        // Symfony's fallback chain ends for a one-subtag locale of four or more letters, and for und.
        expect(await names('/currencies/abcd')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await names('/currencies/und')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await names('/currencies/es_ES')).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
    });

    it('a currency is named from the first Symfony bundle on the display locale’s chain that holds it, its locale matched by case as on the backend’s Linux hosts', async () => {
        const named = (locale: string) => ['EUR', 'CRC'].map((code) => new Intl.DisplayNames([locale], { type: 'currency' }).of(code));
        const stored = 'Test currency (stored)';
        // zh_tw has neither a bundle nor an alias (Symfony's is zh_TW), so it falls back to zh,
        // Simplified; zh_TW's alias, and zh_hant_tw's fallback, reach zh_Hant, Traditional.
        expect(named('zh')).not.toEqual(named('zh-Hant'));
        expect(await names('/currencies/zh-tw')).toEqual([...named('zh'), stored]);
        expect(await names('/currencies/zh_TW')).toEqual([...named('zh-Hant'), stored]);
        expect(await names('/currencies/zh-hant-tw')).toEqual([...named('zh-Hant'), stored]);
        // pt_pt drops its region to pt; sr_latn_ba drops to sr_Latn, and sr_ba to sr.
        expect(named('pt')).not.toEqual(named('pt-PT'));
        expect(await names('/currencies/pt-pt')).toEqual([...named('pt'), stored]);
        expect(await names('/currencies/sr-latn-ba')).toEqual([...named('sr-Latn'), stored]);
        expect(await names('/currencies/sr-ba')).toEqual([...named('sr'), stored]);
        // nb has no bundle, and tl's alias fil none: both fall back to en. iw's alias he has one.
        expect(await names('/currencies/nb')).toEqual([...named('en'), stored]);
        expect(await names('/currencies/tl')).toEqual([...named('en'), stored]);
        expect(await names('/currencies/iw-il')).toEqual([...named('he'), stored]);
        // hi_latn_in drops its region to hi_Latn, whose bundle holds CRC and not EUR, so EUR is
        // named further along, in hi; hi_latn drops its script straight to hi.
        expect(await names('/currencies/hi-latn-in')).toEqual([named('hi')[0], named('hi-Latn')[1], stored]);
        expect(await names('/currencies/hi-latn')).toEqual([...named('hi'), stored]);
    });

    it('a display locale of und with two subtags more fails as the backend fails: Symfony throws a ValueError the controller does not catch', async () => {
        const res = await api('/currencies/und-latn-es');
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('internal_error');
        expect((await api('/countries/und-latn-es')).status).toBe(200);
        // With one subtag more, Symfony throws a MissingResourceException, which keeps the stored names.
        expect(await names('/currencies/und-es')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
    });

    it('a display locale ICU has no data for is named in English, its fallback; a currency ICU cannot name keeps its stored name', async () => {
        expect(await names('/currencies/xx-yy')).toEqual(['Euro', 'Costa Rican Colón', 'Test currency (stored)']);
        expect(await labels('/countries/xx-yy')).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await flat(q('en-us', '&append_target_locales=0'))).body.data['en-us']).toContainEqual({ code: 'es-cr', name: 'Spanish (Costa Rica)' });
    });
});

describe('a case’s lists are taken only when well formed', () => {
    it('a setup is refused with 400 for an unknown code format, a table that is not a list, a row without its code, or a field the lists do not declare, the project’s target locales included; control: well-formed lists are taken', async () => {
        for (const [why, reference] of [
            ['an unknown code format', { ...REFERENCE, locale_code_format: 'upper' }],
            ['a table that is not a list', { ...REFERENCE, countries: 'ES' }],
            ['a row without its code', { ...REFERENCE, currencies: [{ name: 'Euro' }] }],
            ['an empty locale code', { ...REFERENCE, locales: [''] }],
            ['an undeclared field', { ...REFERENCE, languages: [] }],
            ['the project’s target locales, which the clone holds', { ...REFERENCE, target_locales: ['fr-fr'] }],
        ] as const) {
            const refused = await setup(reference);
            expect(refused.status, why).toBe(400);
        }
        expect((await setup({ ...REFERENCE, locale_code_format: 'bcp47' })).status).toBe(200);
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-ES']);
    });

    it('locale codes are held lowercase, as the Locale table stores them', async () => {
        expect((await setup({ ...REFERENCE, locales: ['ES-ES', 'Fr-Fr'] })).status).toBe(200);
        expect(keysOf(await flat(`${q('fr-fr')}&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es', 'fr-fr']);
    });

    it('the helper writes a case’s lists in the code format its world’s seed gives its organisation, and refuses lists that name one', async () => {
        w = seeds.take('posix');
        await fx.use(w, { reference: REFERENCE });
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es_ES']);
        await expect(fx.update(w, { reference: { ...REFERENCE, locale_code_format: 'lowercase-hyphen' } })).rejects.toThrow(/locale-code format its world's seed gives/);
    });
});

describe('the lists name an unknown display locale in English whatever the forwarder’s host’s locale', () => {
    // ICU's own fallback for a display locale it has no data for is the host's default locale.
    const SPANISH_HOST = { LANG: 'es_ES.UTF-8', LC_ALL: 'es_ES.UTF-8' };
    let spanish: ContractFixture;
    beforeAll(async () => {
        spanish = await startContractFixture(SPANISH_HOST);
    });
    afterAll(async () => {
        await spanish?.stop();
    });

    it('control: on that host, ICU’s own fallback is Spanish', () => {
        const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(new Intl.DisplayNames(['zz'], { type: 'currency' }).of('EUR'))"], {
            env: { ...process.env, ...SPANISH_HOST },
            encoding: 'utf8',
        });
        expect(probe.stdout).toBe('euro');
    });

    it('a forwarder on a Spanish host answers xx-yy in English, as a backend host whose ICU default is English does', async () => {
        const c = seeds.take('case');
        await spanish.use(c, { reference: { countries: [{ code: 'ES' }], currencies: [{ code: 'EUR', name: 'Euro (stored)' }] } });
        const read = async (path: string) => (await (await fetch(spanish.baseUrl + path, { headers: { 'x-authorization': c.key('k1') } })).json()).data;
        expect((await read('/currencies/xx-yy')).map((row: { name: string }) => row.name)).toEqual(['Euro']);
        expect((await read('/countries/xx-yy')).map((row: { label: string }) => row.label)).toEqual(['Spain']);
        expect((await read('/currencies/es-es')).map((row: { name: string }) => row.name)).toEqual(['euro']);
    });
});
