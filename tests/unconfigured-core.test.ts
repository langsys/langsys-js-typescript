// @vitest-environment happy-dom
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

/** Collect the rejections of an async method on every instance, so none goes unhandled. */
async function rejectionsOf<T extends object>(proto: T, method: string, into: unknown[]) {
    const original = (proto as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
    vi.spyOn(proto as Record<string, (...args: unknown[]) => Promise<unknown>>, method as never).mockImplementation(function (this: unknown, ...args: unknown[]) {
        const run = original.apply(this, args);
        run.catch((error: unknown) => into.push(error));
        return run;
    } as never);
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

    it('registerBlock, the tree path, rejects with the configuration error and never throws synchronously', async () => {
        const { LangsysApp, LangsysConfigurationError, createSignal } = await page();
        const { registerBlock, renderBlock } = await import('../src/block-tree.js');
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });
        const nodes = [{ tag: 'p', attrs: {}, children: [{ text: 'First sentence.' }] }, { tag: 'p', attrs: {}, children: [{ text: 'Second sentence.' }] }];

        let registration!: Promise<void>;
        expect(() => (registration = registerBlock(nodes))).not.toThrow();
        await expect(registration).rejects.toBeInstanceOf(LangsysConfigurationError);
        // The render itself stays synchronous and shows source, as Translate's does.
        expect(() => renderBlock(nodes)).not.toThrow();
    });

    it('a block registered before init() rejects once init() refuses, as a framework that mounts children first does', async () => {
        const { LangsysApp, LangsysConfigurationError, createSignal } = await page();
        const { registerBlock } = await import('../src/block-tree.js');

        const registration = registerBlock([{ tag: 'p', attrs: {}, children: [{ text: 'First sentence.' }] }, { tag: 'p', attrs: {}, children: [{ text: 'Second sentence.' }] }]);
        const rejection = expect(registration).rejects.toBeInstanceOf(LangsysConfigurationError);
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });

        await rejection;
    });

    it('Phrase and Translate mounted before init() reject once init() refuses', async () => {
        const { LangsysApp, LangsysConfigurationError, createSignal } = await page();
        const { Phrase } = await import('../src/phrase.js');
        const { Translate } = await import('../src/translate.js');
        const byPhrase: unknown[] = [];
        const byTranslate: unknown[] = [];
        await rejectionsOf(Phrase.prototype, '_init', byPhrase);
        await rejectionsOf(Translate.prototype, 'tokenizeContent', byTranslate);
        const phraseHost = document.createElement('p');
        phraseHost.textContent = 'Welcome back';
        const blockHost = document.createElement('div');
        blockHost.innerHTML = '<p>First sentence.</p><p>Second sentence.</p>';
        // A block a server rendered and stamped, which Translate adopts (MARK-3).
        const served = document.createElement('div');
        served.setAttribute('data-ls-resolved', 'es-es');
        served.innerHTML = '<div data-ls-contentblock="0123456789abcdef0123456789abcdef"><p>Hola.</p><p>Adiós.</p></div>';
        document.body.append(phraseHost, blockHost, served);

        // `register: false`: a phrase that never calls t() after the wait still rejects.
        new Phrase(phraseHost, { register: false });
        new Translate(blockHost);
        new Translate(served.firstElementChild as HTMLElement);
        await vi.advanceTimersByTimeAsync(100);
        expect([...byPhrase, ...byTranslate]).toEqual([]);

        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });
        await vi.advanceTimersByTimeAsync(2_000);

        expect(byPhrase).toHaveLength(1);
        expect(byTranslate).toHaveLength(2);
        for (const error of [...byPhrase, ...byTranslate]) expect(error).toBeInstanceOf(LangsysConfigurationError);
    });

    it('control: without it, a block registered before init() resolves once init() refuses', async () => {
        const { LangsysApp, createSignal } = await page();
        const { registerBlock } = await import('../src/block-tree.js');

        const registration = registerBlock([{ tag: 'p', attrs: {}, children: [{ text: 'First sentence.' }] }, { tag: 'p', attrs: {}, children: [{ text: 'Second sentence.' }] }]);
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        await expect(registration).resolves.toBeUndefined();
    });

    it('control: without it, registerBlock resolves', async () => {
        const { LangsysApp, createSignal } = await page();
        const { registerBlock } = await import('../src/block-tree.js');
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });

        await expect(registerBlock([{ tag: 'p', attrs: {}, children: [{ text: 'First sentence.' }] }, { tag: 'p', attrs: {}, children: [{ text: 'Second sentence.' }] }])).resolves.toBeUndefined();
        expect(requests).toEqual([]);
    });

    it('control: without it, Phrase and Translate render source and nothing rejects', async () => {
        const { LangsysApp, createSignal } = await page();
        const { Phrase } = await import('../src/phrase.js');
        const { Translate } = await import('../src/translate.js');
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us') });
        const host = document.createElement('div');
        host.innerHTML = '<p>First sentence.</p><p>Second sentence.</p>';
        const phraseHost = document.createElement('p');
        phraseHost.textContent = 'Welcome back';
        document.body.append(host, phraseHost);

        new Translate(host);
        new Phrase(phraseHost);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(host.textContent).toBe('First sentence.Second sentence.');
        expect(phraseHost.textContent).toBe('Welcome back');
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

describe('WIRE-4: requireCredentials on the component path', () => {
    /**
     * A component never throws from its constructor, which would take the page down. Under
     * `requireCredentials` the core's `Phrase` and `Translate` construct normally, and their
     * asynchronous render rejects with the configuration error: that rejection is the loud
     * failure the option asks for.
     */
    it('Phrase and Translate construct without throwing, and their render rejects with the configuration error', async () => {
        const { LangsysApp, LangsysConfigurationError, createSignal } = await page();
        const { Phrase } = await import('../src/phrase.js');
        const { Translate } = await import('../src/translate.js');
        await LangsysApp.init({ projectid: 'p', key: '', UserLocaleStore: createSignal('en-us'), requireCredentials: true });
        const byPhrase: unknown[] = [];
        const byTranslate: unknown[] = [];
        await rejectionsOf(Phrase.prototype, '_init', byPhrase);
        await rejectionsOf(Translate.prototype, 'tokenizeContent', byTranslate);

        const phraseHost = document.createElement('p');
        phraseHost.textContent = 'Welcome back';
        const blockHost = document.createElement('div');
        blockHost.innerHTML = '<p>First sentence.</p><p>Second sentence.</p>';
        document.body.append(phraseHost, blockHost);

        expect(() => new Phrase(phraseHost)).not.toThrow();
        expect(() => new Translate(blockHost)).not.toThrow();
        await vi.advanceTimersByTimeAsync(2_000);

        // A multi-phrase block never calls t(), so its rejection is Translate's own check.
        expect(byPhrase.length).toBeGreaterThan(0);
        expect(byTranslate.length).toBeGreaterThan(0);
        for (const error of [...byPhrase, ...byTranslate]) expect(error).toBeInstanceOf(LangsysConfigurationError);
        expect(phraseHost.textContent).toBe('Welcome back');
        expect(blockHost.textContent).toBe('First sentence.Second sentence.');
    });
});
