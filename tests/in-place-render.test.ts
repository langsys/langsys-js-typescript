// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCustomId } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * Applying a translation writes into the nodes already on the page, never replacing them,
 * whenever the markup keeps its shape. A reactive framework holds references to the nodes it
 * rendered and keeps writing to them on every state change; a replaced node is detached, so
 * those writes stop reaching the page. The block path always wrote in place; `<Phrase>` and
 * `<option>` text replaced nodes.
 */

const live: Array<{ destroy(): void }> = [];
const settle = () => new Promise((r) => setTimeout(r, 30));

function catalog(entries: Record<string, unknown>) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
}

beforeEach(() => {
    for (const m of ['log', 'warn', 'group', 'groupCollapsed', 'groupEnd'] as const) vi.spyOn(console, m).mockImplementation(() => {});
    currentlyLoadedLocale.set('es-es');
    LangsysApp.Translations.settle();
});
afterEach(() => {
    for (const x of live) x.destroy();
    live.length = 0;
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

function mountPhrase(html: string) {
    const host = document.createElement('span');
    host.innerHTML = html;
    document.body.appendChild(host);
    const held = { lead: host.firstChild!, b: host.querySelector('b')!, inner: host.querySelector('b')!.firstChild! };
    live.push(new Phrase(host, { category: 'UI' }));
    return { host, held };
}

describe('<Phrase> writes into the nodes it was given', () => {
    it('a translation that keeps the markup: the same nodes, still connected, carry it', async () => {
        catalog({ 'Rich {m0o}text{m0c}': 'Texto {m0o}rico{m0c}' });
        const { host, held } = mountPhrase('Rich <b>text</b>');
        await settle();
        expect(host.innerHTML).toBe('Texto <b>rico</b>');
        expect(host.firstChild).toBe(held.lead);
        expect(host.querySelector('b')).toBe(held.b);
        expect(held.inner.isConnected).toBe(true);
    });

    it('a framework’s later write to a node it holds is still visible on the page', async () => {
        catalog({ 'Rich {m0o}text{m0c}': 'Texto {m0o}rico{m0c}' });
        const { host, held } = mountPhrase('Rich <b>text</b>');
        await settle();
        held.inner.nodeValue = 'reactivo';
        expect(host.textContent).toBe('Texto reactivo');
    });

    it('a new catalog re-renders into the same nodes', async () => {
        catalog({ 'Rich {m0o}text{m0c}': 'Texto {m0o}rico{m0c}' });
        const { host, held } = mountPhrase('Rich <b>text</b>');
        await settle();
        catalog({ 'Rich {m0o}text{m0c}': 'Testo {m0o}ricco{m0c}' });
        await settle();
        expect(host.innerHTML).toBe('Testo <b>ricco</b>');
        expect(host.querySelector('b')).toBe(held.b);
    });

    it('control: a translation that reorders the markup still renders, by rebuilding', async () => {
        catalog({ 'Rich {m0o}text{m0c}': '{m0o}rico{m0c} texto' });
        const { host } = mountPhrase('Rich <b>text</b>');
        await settle();
        expect(host.innerHTML).toBe('<b>rico</b> texto');
    });
});

describe('<Phrase> rebuilds only when the markup changes shape', () => {
    it('two elements swapped keep the same shape but not the same order: rebuilt, so each carries its own text', async () => {
        catalog({ '{m0o}a{m0c} and {m1o}b{m1c}': '{m1o}B{m1c} y {m0o}A{m0c}' });
        const host = document.createElement('span');
        host.innerHTML = '<b>a</b> and <i>b</i>';
        document.body.appendChild(host);
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(host.innerHTML).toBe('<i>B</i> y <b>A</b>');
    });
});

describe('<option> text under <Translate> is written into its own text node', () => {
    // A sibling token keeps the host on the content-block path, where the select branch
    // runs; a host whose one token is the option takes the single-token path, which
    // always wrote in place.

    it('the same text node, still connected, carries the translation, and a later write shows', async () => {
        const id = generateCustomId('UI', ['S', 'M']);
        catalog({ [id]: { S: 'Ese', M: 'Eme' } });
        const host = document.createElement('div');
        host.innerHTML = '<select><option>S</option><option>M</option></select>';
        document.body.appendChild(host);
        const text = host.querySelector('option')!.firstChild!;
        live.push(new Translate(host, { category: 'UI' }));
        await settle();
        expect(host.querySelector('option')!.firstChild).toBe(text);
        expect(text.isConnected).toBe(true);
        expect(text.nodeValue).toBe('Ese');
        text.nodeValue = 'Updated';
        expect(host.querySelector('option')!.textContent).toBe('Updated');
    });
});
