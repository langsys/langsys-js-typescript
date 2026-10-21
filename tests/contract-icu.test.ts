import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session } from './helpers/sdk-session.js';

/**
 * ICU-5 against the API (spec CONF-2). The catalog serves a promoted plural as its ICU message
 * only to a client that sends `X-Langsys-Capabilities: icu`, and the core sends it on every
 * catalog request, so a count of 1 renders the singular branch through `t()`.
 */

let fx: ContractFixture;

const PLURAL = '{count, plural, one {# file} other {# files}}';
const SEED = {
    projects: [
        {
            id: 'p1',
            base_locale: 'en',
            target_locales: ['es-es'],
            website_url: 'https://site.local',
            phrases: [{ category: 'UI', phrase: '{count} files', translations: { en: PLURAL } }],
        },
    ],
    keys: [{ key: 'k-read', project: 'p1', type: 'read' }],
};

const tp = (phrase: string, params: Record<string, unknown>) =>
    (LangsysApp.Translations.tSignal.get() as unknown as (p: string, c: string, v: Record<string, unknown>) => string)(phrase, 'UI', params);

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    installBrowser();
    for (const m of ['log', 'info', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    await fx.seed(SEED);
});

describe('ICU-5: the catalog serves a promoted plural as its ICU message to a core that asks for it', () => {
    it('at a count of 1 the singular branch renders through t(), and at another count the plural', async () => {
        await session(fx.baseUrl, 'k-read', { locale: 'en' });
        expect(tp('{count} files', { count: 1 })).toBe('1 file');
        expect(tp('{count} files', { count: 3 })).toBe('3 files');
    });

    it('control: the same catalog read without the header serves the phrase, so the singular came from the ICU message', async () => {
        const res = await fetch(`${fx.baseUrl}/translations?project_id=p1&locale=en`, { headers: { 'x-authorization': 'k-read' } });
        expect((await res.json()).data.UI['{count} files']).toBe('{count} files');
        const icu = await fetch(`${fx.baseUrl}/translations?project_id=p1&locale=en`, { headers: { 'x-authorization': 'k-read', 'x-langsys-capabilities': 'icu' } });
        expect((await icu.json()).data.UI['{count} files']).toBe(PLURAL);
    });
});
