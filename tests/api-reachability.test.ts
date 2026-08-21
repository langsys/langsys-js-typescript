import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';

/**
 * The API base must be redirectable to a test double WITHOUT modifying the
 * built artifact — otherwise the cross-SDK contract fixture is unreachable and
 * everyone patches bundles instead, which is what actually happened.
 *
 * "Redirectable" is not testable on its own: proving `setBaseUrl` exists and is
 * callable proves nothing about whether calling it had an effect. So these
 * assert the redirect is OBSERVED at the double, and that the ordering
 * constraint produces the specific failure it's documented to produce.
 */

const requested: string[] = [];
const DEFAULT_HOST = 'https://api.langsys.dev/api';
const DOUBLE = 'http://double.local/api';

function jsonResponse(body: unknown, ok = true) {
    return {
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? 'OK' : 'Error',
        url: '',
        headers: { get: () => 'application/json' },
        json: async () => body,
    } as unknown as Response;
}

beforeEach(() => {
    requested.length = 0;
    LangsysAppAPI.setBaseUrl(DEFAULT_HOST);
});

afterEach(() => {
    vi.restoreAllMocks();
    LangsysAppAPI.setBaseUrl(DEFAULT_HOST);
});

describe('the API base is redirectable to a double', () => {
    it('sends requests to the redirected host, not the default', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            requested.push(String(url));
            return jsonResponse({ status: true, data: {} });
        });

        LangsysAppAPI.setup({
            projectid: 'p',
            key: 'k',
            sUserLocale: createSignal('en-US'),
            baseLocale: 'en-US',
        });
        LangsysAppAPI.setBaseUrl(DOUBLE);
        await LangsysAppAPI.get('authorize-project/[projectid]');

        // Observed at the double, rather than merely "the setter was callable".
        expect(requested).toHaveLength(1);
        expect(requested[0].startsWith(DOUBLE)).toBe(true);
        expect(requested.some((u) => u.startsWith(DEFAULT_HOST))).toBe(false);
    });

    it('tolerates a trailing slash rather than producing a doubled one', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            requested.push(String(url));
            return jsonResponse({ status: true, data: {} });
        });

        LangsysAppAPI.setup({
            projectid: 'p',
            key: 'k',
            sUserLocale: createSignal('en-US'),
            baseLocale: 'en-US',
        });
        LangsysAppAPI.setBaseUrl(`${DOUBLE}/`);
        await LangsysAppAPI.get('translations');

        expect(requested[0]).not.toContain('//api//');
        expect(requested[0].startsWith(`${DOUBLE}/translations`)).toBe(true);
    });
});

describe('the ordering constraint, proven by redirecting too late', () => {
    it('leaves the SDK permanently inert when setBaseUrl runs after init', async () => {
        // The documented failure: init() has already authorized against the
        // default host and failed, and the locale subscription is installed
        // closed over that failed result — so it no-ops for the life of the
        // app. Fixing the URL afterwards does not recover it, and neither does
        // a locale change. Nothing throws; init()'s return value is the only
        // signal that exists.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            requested.push(String(url));
            // The default host rejects this key — the real-world shape of
            // pointing a local key at production.
            if (String(url).startsWith(DEFAULT_HOST)) return jsonResponse({ status: false, errors: ['Unauthorized'] }, false);
            return jsonResponse({ status: true, data: {} });
        });

        const locale = createSignal('en-US');
        const res = await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: locale,
            baseLocale: 'en-US',
        });

        expect(res.status).toBe(false); // the one visible signal

        // Now do the thing that looks like it should fix it.
        LangsysAppAPI.setBaseUrl(DOUBLE);
        requested.length = 0;
        locale.set('fr-FR');
        await new Promise((r) => setTimeout(r, 50));

        // Inert: the locale change reaches a subscription that returns
        // immediately, so no catalog is ever fetched — from either host.
        expect(requested.filter((u) => u.includes('/translations'))).toEqual([]);
    });
});

describe('the apiUrl init option removes the ordering constraint', () => {
    it('authorizes against apiUrl and never touches the default host', async () => {
        // The ordering hazard above exists only because the host is configured
        // by a separate call that can run too late. An init option cannot be
        // ordered wrong: it is applied before `validate()`, in the same call
        // that consumes it.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            requested.push(String(url));
            if (String(url).startsWith(DEFAULT_HOST)) return jsonResponse({ status: false, errors: ['Unauthorized'] }, false);
            return jsonResponse({ status: true, data: {} });
        });

        const res = await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('en-us'),
            baseLocale: 'en',
            apiUrl: DOUBLE,
        });

        expect(res.status).toBe(true);
        expect(requested.length).toBeGreaterThan(0);
        // Not "it eventually used the double" — it never used the default at
        // all, which is the property the separate call cannot guarantee.
        expect(requested.every((u) => u.startsWith(DOUBLE))).toBe(true);
    });

    it('leaves the default host in place when apiUrl is absent', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
            requested.push(String(url));
            return jsonResponse({ status: true, data: {} });
        });

        await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('en-us'),
            baseLocale: 'en',
        });

        expect(requested.every((u) => u.startsWith(DEFAULT_HOST))).toBe(true);
    });
});

describe('WIRE-1: authorization header', () => {
    it('sends the API key as x-Authorization on every request', async () => {
        const seen: Array<Record<string, string>> = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            requested.push(String(url));
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return jsonResponse({ status: true, data: {} });
        });

        LangsysAppAPI.setup({
            projectid: 'p',
            key: 'the-api-key',
            sUserLocale: createSignal('en-US'),
            baseLocale: 'en-US',
        });

        await LangsysAppAPI.get('authorize-project/[projectid]');
        await LangsysAppAPI.post('translatable-items', { project_id: 'p', translatable_items: [] });

        expect(seen).toHaveLength(2);
        for (const headers of seen) {
            expect(headers['x-Authorization']).toBe('the-api-key');
        }
    });

    it('declares the ICU capability alongside it', async () => {
        const seen: Array<Record<string, string>> = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
            requested.push(String(url));
            seen.push((init?.headers ?? {}) as Record<string, string>);
            return jsonResponse({ status: true, data: {} });
        });

        LangsysAppAPI.setup({
            projectid: 'p',
            key: 'the-api-key',
            sUserLocale: createSignal('en-US'),
            baseLocale: 'en-US',
        });
        await LangsysAppAPI.get('translations');

        expect(seen[0]['X-Langsys-Capabilities']).toBe('icu');
    });
});
