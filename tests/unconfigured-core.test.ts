import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WIRE-4's unconfigured core. `init()` without credentials does not throw: a translate call
 * renders the source with its params filled, makes no request and queues no miss; a block
 * registration, which a component reaches, resolves skipped with reason `not-configured`; an
 * explicit write throws `LangsysConfigurationError`; and `isConfigured()` reports the state.
 * `requireCredentials` makes `t()` throw instead. A refused authorization settles the
 * capability as not writable, so nothing waits on it.
 *
 * Requests are counted at the transport seam, since an absence is the claim. Each case is a
 * fresh page load, because the core is a module singleton.
 */

const BLOCK = { custom_id: 'b1', category: 'UI', content: '<p>Hi</p>', label: '', tokens: ['Hi'] };

let requests: string[];

function respond(status: number, body: unknown) {
    return {
        status,
        ok: status >= 200 && status < 300,
        statusText: status === 401 ? 'Unauthorized' : 'OK',
        url: 'https://api.local/x',
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

async function page(answer: (url: string) => ReturnType<typeof respond> = () => respond(401, { status: false })) {
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        requests.push(String(url));
        return answer(String(url));
    }));
    vi.stubGlobal('window', { addEventListener: () => {}, location: { href: 'https://site.local/p' } });
    vi.stubGlobal('document', { addEventListener: () => {}, visibilityState: 'visible' });
    vi.resetModules();
    const { LangsysApp } = await import('../src/langsys-app.js');
    const { LangsysAppAPI, LangsysConfigurationError } = await import('../src/api.js');
    const { registerContentBlock } = await import('../src/content-block.js');
    const { createSignal } = await import('../src/signal.js');
    const stores = await import('../src/stores.js');
    const t = (phrase: string, params?: Record<string, unknown>) =>
        (LangsysApp.t as unknown as (p: string, q?: Record<string, unknown>) => string)(phrase, params);
    const queued = () => (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens.length;
    return { LangsysApp, LangsysAppAPI, LangsysConfigurationError, registerContentBlock, createSignal, stores, t, queued };
}

/** Resolves with the promise's value, or 'pending' if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
    const timeout = new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms));
    const raced = Promise.race([promise, timeout]);
    await vi.advanceTimersByTimeAsync(ms);
    return raced;
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
    vi.resetModules();
});

describe('WIRE-4: init() without credentials leaves the client unconfigured, without throwing', () => {
    it('resolves a refusal and isConfigured() reports false, before init() and after it', async () => {
        const { LangsysApp, createSignal } = await page();
        expect(LangsysApp.isConfigured()).toBe(false);

        const res = await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        expect(res.status).toBe(false);
        expect(LangsysApp.isConfigured()).toBe(false);
        expect(requests).toEqual([]);
    });

    it('reads take the catalog-failed path, and the capability settles as not writable', async () => {
        const { LangsysApp, createSignal, stores } = await page();

        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        expect(stores.catalogUnavailable.get()).toBe(true);
        expect(stores.writeEnabled.get()).toBe(false);
    });

    it('control: with a project id and a key it is configured, whatever authorization answers', async () => {
        const { LangsysApp, createSignal } = await page();

        await LangsysApp.init({ projectid: 'p', key: 'k', UserLocaleStore: createSignal('en-us') });

        expect(LangsysApp.isConfigured()).toBe(true);
    });

    it('a translate call renders the source with the params filled, makes no request, and queues no miss', async () => {
        const { LangsysApp, createSignal, t, queued } = await page();
        // A render before init() queues its miss, as a page that renders first does.
        t('Rendered before init');
        expect(queued()).toBe(1);

        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });
        expect(t('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
        expect(t('Plain text')).toBe('Plain text');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(queued()).toBe(0);
        expect(requests).toEqual([]);
    });

    it('a block registration resolves skipped with reason not-configured, and sends nothing', async () => {
        const { LangsysApp, createSignal, registerContentBlock } = await page();
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        expect(await within(registerContentBlock(BLOCK), 1_000)).toEqual({ status: false, skipped: true, reason: 'not-configured' });
        expect(requests).toEqual([]);
    });

    it('an explicit write throws LangsysConfigurationError and sends nothing; a read answers with an error', async () => {
        const { LangsysApp, LangsysAppAPI, LangsysConfigurationError, createSignal } = await page();
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        await expect(LangsysAppAPI.createTranslatableItems([{ phrase: 'Hi' }])).rejects.toBeInstanceOf(LangsysConfigurationError);
        await expect(LangsysAppAPI.post('translatable-items', {})).rejects.toThrow(/not configured/);
        expect(await LangsysAppAPI.get('translations')).toMatchObject({ status: false });
        expect(requests).toEqual([]);
    });

    it('a refused re-init forgets the credentials an earlier init() accepted', async () => {
        const { LangsysApp, LangsysAppAPI, LangsysConfigurationError, createSignal } = await page();
        await LangsysApp.init({ projectid: 'p', key: 'k', UserLocaleStore: createSignal('en-us') });
        expect(LangsysApp.isConfigured()).toBe(true);
        const before = requests.length;

        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        expect(LangsysApp.isConfigured()).toBe(false);
        await expect(LangsysAppAPI.createTranslatableItems([{ phrase: 'Hi' }])).rejects.toBeInstanceOf(LangsysConfigurationError);
        expect(requests.length).toBe(before);
    });
});

describe('WIRE-4: requireCredentials', () => {
    it('makes t() throw the configuration error, naming what is missing', async () => {
        const { LangsysApp, LangsysConfigurationError, createSignal, t } = await page();
        const res = await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });

        expect(res.status).toBe(false);
        expect(() => t('Hello')).toThrow(LangsysConfigurationError);
        expect(() => t('Hello')).toThrow(/without an API key/);
    });

    it('stops throwing once a later init() is configured', async () => {
        const { LangsysApp, createSignal, t } = await page();
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });

        await LangsysApp.init({ projectid: 'p', key: 'k', UserLocaleStore: createSignal('en-us'), requireCredentials: true });

        expect(t('Hello')).toBe('Hello');
    });
});

describe('WIRE-4: a refused authorization settles the capability as not writable', () => {
    it('a block registration resolves with its existing reason instead of waiting forever', async () => {
        const { LangsysApp, createSignal, registerContentBlock, stores } = await page(() => respond(401, { status: false }));
        const res = await LangsysApp.init({ projectid: 'p', key: 'bad', UserLocaleStore: createSignal('en-us') });

        expect(res.status).toBe(false);
        expect(stores.writeEnabled.get()).toBe(false);
        expect(await within(registerContentBlock(BLOCK), 1_000)).toEqual({ status: false, skipped: true, reason: 'not-write-enabled' });
    });

    it('queues no miss, and makes no request after the refusal', async () => {
        const { LangsysApp, createSignal, t, queued } = await page(() => respond(401, { status: false }));
        await LangsysApp.init({ projectid: 'p', key: 'bad', UserLocaleStore: createSignal('en-us') });
        const after = requests.length;

        expect(t('Hello {name}', { name: 'Ada' })).toBe('Hello Ada');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(queued()).toBe(0);
        expect(requests.length).toBe(after);
    });
});
