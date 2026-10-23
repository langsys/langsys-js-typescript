import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import seeds, { PLURAL } from './contract-seeds/contract-icu.js';
import type { World } from './contract-seeds/worlds.js';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { installBrowser, resetSdk, session } from './helpers/sdk-session.js';

/**
 * ICU-5 against the API (spec CONF-2). The catalog serves a promoted plural as its ICU message
 * only to a client that sends `X-Langsys-Capabilities: icu`, and the core sends it on every
 * catalog request, so a count of 1 renders the singular branch through `t()`.
 */

let fx: ContractFixture;
let w: World;

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
    w = seeds.take('plural');
    await fx.use(w);
});

describe('ICU-5: the catalog serves a promoted plural as its ICU message to a core that asks for it', () => {
    it('at a count of 1 the singular branch renders through t(), and at another count the plural', async () => {
        await session(fx.baseUrl, w.key('k-read'), { locale: 'en', project: w.project() });
        expect(tp('{count} files', { count: 1 })).toBe('1 file');
        expect(tp('{count} files', { count: 3 })).toBe('3 files');
    });

    it('control: the same catalog read without the header serves the phrase, so the singular came from the ICU message', async () => {
        const catalog = `${fx.baseUrl}/translations?project_id=${w.project()}&locale=en`;
        const res = await fetch(catalog, { headers: { 'x-authorization': w.key('k-read') } });
        expect((await res.json()).data.UI['{count} files']).toBe('{count} files');
        const icu = await fetch(catalog, { headers: { 'x-authorization': w.key('k-read'), 'x-langsys-capabilities': 'icu' } });
        expect((await icu.json()).data.UI['{count} files']).toBe(PLURAL);
    });
});
