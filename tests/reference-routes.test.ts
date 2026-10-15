import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { resetSdk } from './helpers/sdk-session.js';

/**
 * The locale display lists come from the API's current locale routes: `locales`,
 * `locales/flat` and `locales/data`, each naming its display locale as `locales[]` and
 * answering a map keyed by that locale, in the organization's locale-code format. Unless
 * asked not to, the API adds one list per target locale of the key's project, so the
 * methods ask with `append_target_locales=0`, and hand back the one list asked for, its
 * codes in the core's lowercase form, so their return shape is the list itself.
 *
 * The shared contract double leaves the reference routes out of contract, so this file
 * answers them with a double of its own, from the backend's LocaleController (langsys
 * feature/838_write_key_gating a9df4ef9): the current routes answer, and the deprecated
 * `locales/{locale}/{format}` is 404 here, so a method still calling it gets nothing.
 */

const BASE = 'https://reference.test/api';

const CATEGORIZED = { Spanish: [{ code: 'es-es', name: 'Spanish (Spain)' }] };
const FLAT = [{ code: 'es-es', name: 'Spanish (Spain)' }];
const DATA = [{ code: 'es-es', locale_name: 'Spanish (Spain)', lang_name: 'Spanish' }];

/** The organization's locale-code setting, as LocaleController applies it to keys and codes. */
let codeFormat: (code: string) => string = (code) => code;
let requested: string[] = [];

function answer(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function referenceDouble(input: string | URL | Request): Response {
    const url = new URL(String(input));
    const path = url.pathname.slice('/api'.length);
    requested.push(path + url.search);
    const lists: Record<string, unknown> = { '/locales': CATEGORIZED, '/locales/flat': FLAT, '/locales/data': DATA };
    if (!(path in lists)) return answer(404, { status: false, errors: [{ code: 'not_found' }] });
    // LocalesIndexRequest's `bool $append_target_locales = true`: Laravel's `boolean` rule, which a
    // query string meets only as '0' or '1', and anything else is a 422.
    const flag = url.searchParams.get('append_target_locales');
    if (flag !== null && flag !== '0' && flag !== '1') return answer(422, { status: false, errors: [{ field: 'append_target_locales', code: 'boolean' }] });
    const append = flag !== '0';
    const locales = [...url.searchParams.getAll('locales[]'), ...(append ? ['it-it', 'fr-fr'] : [])];
    const recode = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(recode)
            : typeof value === 'object' && value !== null
              ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'code' ? codeFormat(String(v)) : recode(v)]))
              : value;
    return answer(200, { status: true, data: Object.fromEntries(locales.map((locale) => [codeFormat(locale), recode(lists[path])])) });
}

beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    resetSdk();
    codeFormat = (code) => code;
    requested = [];
    (LangsysApp as unknown as { locales: Record<string, unknown> }).locales = {};
    LangsysAppAPI.setBaseUrl(BASE);
    LangsysAppAPI.setup({ projectid: 'p1', key: 'k1', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => referenceDouble(input as string));
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe('locale display lists come from the current locale routes', () => {
    it('getLocales: GET locales with the display locale as locales[], answered as the list itself', async () => {
        expect(await LangsysApp.getLocales('es-es')).toEqual(CATEGORIZED);
        expect(requested).toEqual(['/locales?locales%5B%5D=es-es&append_target_locales=0']);
    });

    it('getLocalesFlat: GET locales/flat', async () => {
        expect(await LangsysApp.getLocalesFlat('es-es')).toEqual(FLAT);
        expect(requested).toEqual(['/locales/flat?locales%5B%5D=es-es&append_target_locales=0']);
    });

    it('getLocalesData: GET locales/data', async () => {
        expect(await LangsysApp.getLocalesData('es-es')).toEqual(DATA);
        expect(requested).toEqual(['/locales/data?locales%5B%5D=es-es&append_target_locales=0']);
    });

    it('control: the deprecated locales/{locale}/{format} is 404 on this double', async () => {
        const response = await LangsysAppAPI.get('locales/es-es/data');
        expect(response.status).toBe(false);
        expect(response.http?.status).toBe(404);
    });

    it.each([
        ['bcp47', (code: string) => code.replace(/-([a-z]{2})$/, (_, region: string) => '-' + region.toUpperCase())],
        ['posix', (code: string) => code.replace(/-([a-z]{2})$/, (_, region: string) => '_' + region.toUpperCase())],
    ])('an organization whose locale codes are %s gets its list with the codes in the core’s lowercase form', async (_, format) => {
        codeFormat = format;
        expect(await LangsysApp.getLocales('es-es')).toEqual(CATEGORIZED);
        expect(await LangsysApp.getLocalesFlat('es-es')).toEqual(FLAT);
        expect(await LangsysApp.getLocalesData('es-es')).toEqual(DATA);
        expect(await LangsysApp.getLocaleNameWithLookup('es-es', false, 'es-es')).toBe('Spanish (Spain)');
    });

    it('a display locale the API does not list answers an empty list of the method’s shape', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer(200, { status: true, data: [] }));
        expect(await LangsysApp.getLocales('xx-yy')).toEqual({});
        expect(await LangsysApp.getLocalesFlat('xx-yy')).toEqual([]);
        expect(await LangsysApp.getLocalesData('xx-yy')).toEqual([]);
    });
});
