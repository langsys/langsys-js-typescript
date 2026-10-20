import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { autoDiscovery, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * The write-grant lane. Every case here was previously unproven in-repo, and
 * `setWriteGrant` in particular shipped INERT — it set config and nothing else,
 * so a grant supplied after login took effect on no request at all.
 */

interface Req {
    url: string;
    headers: Record<string, string>;
}

let requests: Req[] = [];
let authPayload: Record<string, unknown> = { key_type: 'read', write_enabled: false };

function jsonResponse(body: unknown) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: '',
        headers: { get: () => 'application/json' },
        json: async () => body,
    } as unknown as Response;
}

function baseConfig() {
    return {
        projectid: 'p',
        key: 'k',
        sUserLocale: createSignal('en-US'),
        baseLocale: 'en-US',
    };
}

beforeEach(() => {
    // writeEnabled is browser-authoritative — never written without a window —
    // so the capability assertions below need a browser-shaped environment.
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener: () => {}, location: { href: 'https://s.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };

    requests = [];
    authPayload = { key_type: 'read', write_enabled: false };
    writeEnabled.set(undefined);
    autoDiscovery.set(undefined);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        requests.push({
            url: String(url),
            headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (String(url).includes('authorize-project')) {
            return jsonResponse({ status: true, data: authPayload });
        }
        return jsonResponse({ status: true, data: {} });
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    LangsysApp.setWriteGrant(undefined);
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
});

describe('X-Write-Grant header', () => {
    it('is attached when a grant is configured, and resolved per request', async () => {
        let resolved = 0;
        LangsysAppAPI.setup({ ...baseConfig(), writeGrant: () => `jwt-${++resolved}` });

        await LangsysAppAPI.get('authorize-project/[projectid]');
        await LangsysAppAPI.get('authorize-project/[projectid]');

        expect(requests[0].headers['X-Write-Grant']).toBe('jwt-1');
        // Resolved again rather than cached — that is what lets a host app
        // refresh a ~5 minute token by simply returning a new one.
        expect(requests[1].headers['X-Write-Grant']).toBe('jwt-2');
    });

    it('is absent when no grant is configured', async () => {
        LangsysAppAPI.setup(baseConfig());
        await LangsysAppAPI.get('authorize-project/[projectid]');
        expect(requests[0].headers['X-Write-Grant']).toBeUndefined();
    });

    it('is absent when the provider returns null — "no grant yet" is not an error', async () => {
        LangsysAppAPI.setup({ ...baseConfig(), writeGrant: () => null });
        await LangsysAppAPI.get('authorize-project/[projectid]');
        expect(requests[0].headers['X-Write-Grant']).toBeUndefined();
    });

    it('survives a throwing provider rather than taking the request down', async () => {
        LangsysAppAPI.setup({
            ...baseConfig(),
            writeGrant: () => {
                throw new Error('auth layer exploded');
            },
        });

        const res = await LangsysAppAPI.get('authorize-project/[projectid]');

        expect(res.status).toBe(true); // request still went out
        expect(requests[0].headers['X-Write-Grant']).toBeUndefined();
    });
});

describe('setWriteGrant re-authorizes', () => {
    it('issues a fresh authorization carrying the grant — it shipped inert without this', async () => {
        await LangsysApp.init({ ...baseConfig(), UserLocaleStore: createSignal('en-US') });
        requests = [];

        authPayload = { key_type: 'read', write_enabled: true, auto_discovery: false };
        await LangsysApp.setWriteGrant(() => 'a-real-jwt');

        const auth = requests.filter((r) => r.url.includes('authorize-project'));
        expect(auth.length).toBeGreaterThan(0);
        expect(auth[0].headers['X-Write-Grant']).toBe('a-real-jwt');
    });

    it('applies the re-authorized capability', async () => {
        await LangsysApp.init({ ...baseConfig(), UserLocaleStore: createSignal('en-US') });
        expect(writeEnabled.get()).toBe(false);

        authPayload = { key_type: 'read', write_enabled: true };
        await LangsysApp.setWriteGrant(() => 'a-real-jwt');

        expect(writeEnabled.get()).toBe(true);
    });

    it('also applies auto_discovery on re-auth, not only at init', async () => {
        authPayload = { key_type: 'read', write_enabled: false, auto_discovery: true };
        await LangsysApp.init({ ...baseConfig(), UserLocaleStore: createSignal('en-US') });
        expect(autoDiscovery.get()).toBe(true);

        // A policy change must be picked up by the re-auth path too.
        authPayload = { key_type: 'read', write_enabled: false, auto_discovery: false };
        await LangsysApp.setWriteGrant(() => 'a-real-jwt');

        expect(autoDiscovery.get()).toBe(false);
    });
});

describe('held misses', () => {
    function newTranslations(writeGrant?: () => string | null) {
        return new Translations({ ...baseConfig(), writeGrant });
    }

    it('flushes what was held once capability resolves true', async () => {
        const post = vi
            .spyOn(LangsysAppAPI, 'createTranslatableItems')
            .mockResolvedValue({ status: true });
        writeEnabled.set(undefined); // not yet authorized — must HOLD, not drop
        const tr = newTranslations();
        tr.t('Seen before auth resolved', 'UI');
        expect(post).not.toHaveBeenCalled();

        writeEnabled.set(true);
        await new Promise((r) => setTimeout(r, 700));

        expect(post).toHaveBeenCalled();
        expect(post.mock.calls[0][0][0].phrase).toBe('Seen before auth resolved');
    });

    it('keeps holding for a read-only session when a grant provider is configured', () => {
        // A provider returning null pre-login is what keeps the queue alive:
        // an unset grant says no grant can ever arrive, so the queue is released.
        const tr = newTranslations(() => null);
        LangsysAppAPI.setup({ ...baseConfig(), writeGrant: () => null });
        writeEnabled.set(false);
        tr.t('Pre-login phrase', 'UI');

        const queue = (tr as unknown as { missingTokens: unknown[] }).missingTokens;
        expect(queue).toHaveLength(1);
    });
});

describe('REG-9: the batch limit is server-authoritative', () => {
    it('honours a lower limit sent on authorization rather than assuming 200', async () => {
        const { batchLimit } = await import('../src/stores.js');
        authPayload = {
            key_type: 'write',
            write_enabled: true,
            langsys_settings: { translatable_items: { batch_limit: 25 } },
        };

        await LangsysApp.init({ ...baseConfig(), UserLocaleStore: createSignal('en-US') });

        expect(batchLimit.get()).toBe(25);
    });

    it('keeps the default when the server does not send one', async () => {
        const { batchLimit } = await import('../src/stores.js');
        batchLimit.set(200);
        authPayload = { key_type: 'write', write_enabled: true };

        await LangsysApp.init({ ...baseConfig(), UserLocaleStore: createSignal('en-US') });

        expect(batchLimit.get()).toBe(200);
    });

    it('chunks sends to the server limit', async () => {
        const { batchLimit } = await import('../src/stores.js');
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true });
        batchLimit.set(3);
        writeEnabled.set(true);

        const tr = new Translations(baseConfig());
        for (let i = 0; i < 7; i++) tr.t(`Batched ${i}`, 'UI');
        await new Promise((r) => setTimeout(r, 700));

        // Count only this test's own phrases — instances from earlier tests
        // keep a 3s backstop interval running and nothing disposes them.
        const mine = post.mock.calls
            .map((c) => c[0] as Array<{ phrase?: string }>)
            .filter((items) => items.some((i) => String(i.phrase).startsWith('Batched ')));

        // 7 phrases at a limit of 3 => 3 requests, none over the limit.
        expect(mine).toHaveLength(3);
        expect(mine.every((items) => items.length <= 3)).toBe(true);
        batchLimit.set(200);
    });
});
