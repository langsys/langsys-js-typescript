// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Regression: with no credentials (e.g. the public demo apps on StackBlitz),
 * init() rejects the config before any catalog load is scheduled, so
 * Translations.ready() never resolved and Phrase never ran _render() — the
 * host kept its raw `%name%` marker children forever. A rejected init must
 * settle the ready() gate so Phrase falls back to the interpolated source.
 */
describe('Phrase fallback when init is rejected', () => {
    it('renders interpolated source text instead of raw %markers%', async () => {
        const result = await LangsysApp.init({ projectid: '', key: '' } as never);
        expect(result.status).toBe(false);

        const host = document.createElement('p');
        host.textContent = 'Hi %name%, you have %count% items in your cart.';
        new Phrase(host, { category: 'Cart', params: { name: 'Sarah', count: 3 } });

        await LangsysApp.Translations.ready(); // hung forever before the fix
        await flush();

        expect(host.textContent).toBe('Hi Sarah, you have 3 items in your cart.');
    });

    it('setParams re-renders the fallback', async () => {
        const host = document.createElement('p');
        host.textContent = 'Hi %name%, you have %count% items in your cart.';
        const phrase = new Phrase(host, { category: 'Cart', params: { name: 'Sarah', count: 3 } });

        await LangsysApp.Translations.ready();
        await flush();

        phrase.setParams({ name: 'Sarah', count: 4 });
        expect(host.textContent).toBe('Hi Sarah, you have 4 items in your cart.');
    });
});
