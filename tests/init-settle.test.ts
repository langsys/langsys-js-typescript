import { describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';

/**
 * Regression: when project authorization fails (bad key, unreachable server),
 * the locale subscription short-circuits on !validateResponse.status, so no
 * catalog will ever load. init() must settle Translations.ready() so DOM
 * consumers (Phrase/Translate) render their source-text fallback instead of
 * awaiting forever.
 */
describe('init settles ready() when authorization fails', () => {
    it('ready() resolves after a failed validate', async () => {
        vi.spyOn(LangsysAppAPI, 'validate').mockResolvedValue({
            status: false,
            errors: ['HTTP 401: Unauthorized'],
        });

        const result = await LangsysApp.init({
            projectid: 'test-project',
            key: 'bad-key',
            UserLocaleStore: createSignal('en-US'),
        });
        expect(result.status).toBe(false);

        await expect(LangsysApp.Translations.ready()).resolves.toBeUndefined(); // hung forever before the fix
    });
});
