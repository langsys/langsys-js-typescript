import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';

/**
 * `Phrase` and `Translate` both `await LangsysApp.Translations.ready()` before
 * rendering. Nothing resolved that promise on the paths where no catalog is
 * ever coming, so those components waited forever — a permanent blank render
 * with no error, on the most common misconfigurations there are.
 */

const SETTLED = 'settled';

async function readyWithin(ms: number): Promise<string> {
    return Promise.race([
        LangsysApp.Translations.ready().then(() => SETTLED),
        new Promise<string>((r) => setTimeout(() => r('hung'), ms)),
    ]);
}

afterEach(() => {
    vi.restoreAllMocks();
    LangsysAppAPI.setBaseUrl('https://api.langsys.dev/api');
});

describe('init settles the ready() gate when no catalog can arrive', () => {
    // `ready()` resolves ONCE and the app owns a single Translations instance,
    // so only the first of these can observe the promise actually resolving —
    // after that it is already settled and every later assertion passes for
    // free. The remaining paths are therefore checked at the call, which is
    // the part that was missing, and this first test proves the call has the
    // effect the others assume.
    it('settles on a rejected config, and ready() actually resolves', async () => {
        const res = await LangsysApp.init({
            projectid: '',
            key: 'k',
            UserLocaleStore: createSignal('en-us'),
        });

        expect(res.status).toBe(false);
        expect(await readyWithin(100)).toBe(SETTLED);
    });

    it('settles on a missing key', async () => {
        const settle = vi.spyOn(LangsysApp.Translations, 'settle');

        const res = await LangsysApp.init({
            projectid: 'p',
            key: '',
            UserLocaleStore: createSignal('en-us'),
        });

        expect(res.status).toBe(false);
        expect(settle).toHaveBeenCalled();
    });

    it('settles on a missing UserLocaleStore', async () => {
        const settle = vi.spyOn(LangsysApp.Translations, 'settle');

        const res = await LangsysApp.init({
            projectid: 'p',
            key: 'k',
        } as unknown as Parameters<typeof LangsysApp.init>[0]);

        expect(res.status).toBe(false);
        expect(settle).toHaveBeenCalled();
    });

    it('settles when authorization itself fails', async () => {
        // Not a config mistake — a bad key, a wrong host, an unreachable
        // server. The locale subscription short-circuits on a failed
        // authorization, so no catalog is ever fetched and nothing else
        // would resolve the gate.
        vi.spyOn(globalThis, 'fetch').mockImplementation(
            async () =>
                ({
                    ok: false,
                    status: 401,
                    statusText: 'Unauthorized',
                    url: '',
                    headers: { get: () => 'application/json' },
                    json: async () => ({ status: false, errors: ['Unauthorized'] }),
                }) as unknown as Response
        );
        const settle = vi.spyOn(LangsysApp.Translations, 'settle');

        const res = await LangsysApp.init({
            projectid: 'p',
            key: 'bad',
            UserLocaleStore: createSignal('en-us'),
        });

        expect(res.status).toBe(false);
        expect(settle).toHaveBeenCalled();
    });
});
