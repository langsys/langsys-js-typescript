// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { _resetSeededBlocks } from '../src/served-source.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * SRV-5: the content a `<Translate>` shows at mount is provisional. A framework
 * mounts a block with a placeholder in it (a Suspense fallback, a lazy child's
 * spinner) and swaps in the real content a moment later; the block registers what
 * it shows once its structure has been quiet for the settle window (250ms), and a
 * later structural change re-derives it. Text changes never re-key it.
 */

type Item = { type: string; phrase?: string; custom_id?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Translate[] = [];
const blocks = () => sent.filter((i) => i.type === 'content_block').map((i) => (i.phrases ?? []).map((p) => p.phrase));
const phrases = () => sent.filter((i) => i.type === 'phrase').map((i) => i.phrase);

function catalog(entries: Record<string, unknown>, locale = 'es-es') {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
    currentlyLoadedLocale.set(locale);
}
function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    live.push(new Translate(host, { category: 'UI' }));
    return host;
}
/** What a framework does when a lazy child resolves: the fallback node is replaced. */
function resolveFallback(host: HTMLElement, html: string) {
    const fallback = host.lastElementChild!;
    const real = document.createElement('div');
    real.innerHTML = html;
    host.replaceChild(real.firstElementChild!, fallback);
}

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    _resetSeededBlocks();
    catalog({});
    writeEnabled.set(true);
    LangsysApp.Translations.settle();
    sent = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        sent.push(...(items as Item[]));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
});

afterEach(() => {
    for (const x of live) x.destroy();
    live.length = 0;
    (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
    Object.assign(configStore, { projectid: '', key: '' });
    document.body.innerHTML = '';
});

describe('SRV-5: a placeholder swapped out inside the settle window never registers', () => {
    it('React’s vector: an intro and a Suspense fallback, the lazy child resolving at 100ms', async () => {
        const host = mount('<p>Intro one</p><p>Loading spinner</p>');
        await vi.advanceTimersByTimeAsync(100);
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        expect(blocks()).toEqual([['Intro one', 'Real content']]);
        expect(JSON.stringify(sent)).not.toContain('Loading spinner');
        expect(host.getAttribute('data-ls-contentblock')).toBe(generateCustomId('UI', ['Intro one', 'Real content']));
    });

    it('a single-token fallback swapped for the content registers only the content', async () => {
        const host = mount('<p>Loading spinner</p>');
        await vi.advanceTimersByTimeAsync(100);
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        expect(phrases()).toEqual(['Real content']);
    });

    it('the settled content renders its translation', async () => {
        catalog({ [generateCustomId('UI', ['Intro one', 'Real content'])]: { 'Intro one': 'Intro uno', 'Real content': 'Contenido real' } });
        const host = mount('<p>Intro one</p><p>Loading spinner</p>');
        await vi.advanceTimersByTimeAsync(100);
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        expect(host.textContent).toBe('Intro unoContenido real');
        expect(sent).toEqual([]);
    });
});

describe('SRV-5: a structural change after the window re-keys the block', () => {
    it('a placeholder that outlives the window registers, and the content registers when it arrives', async () => {
        const host = mount('<p>Intro one</p><p>Loading spinner</p>');
        await vi.advanceTimersByTimeAsync(1000);
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        // The provisional id was sent before the content existed; the core cannot take it back.
        expect(blocks()).toEqual([
            ['Intro one', 'Loading spinner'],
            ['Intro one', 'Real content'],
        ]);
        expect(host.getAttribute('data-ls-contentblock')).toBe(generateCustomId('UI', ['Intro one', 'Real content']));
    });

    it('the hazard, pinned: a keyed list whose length changes re-keys, as a fresh mount of that state would', async () => {
        const host = mount('<ul><li>One</li><li>Two</li></ul>');
        await vi.advanceTimersByTimeAsync(1000);
        const li = document.createElement('li');
        li.textContent = 'Three';
        host.querySelector('ul')!.appendChild(li);
        await vi.advanceTimersByTimeAsync(1000);
        expect(blocks()).toEqual([
            ['One', 'Two'],
            ['One', 'Two', 'Three'],
        ]);
    });

    it('an app’s own custom_id keeps its id when the structure changes', async () => {
        const host = document.createElement('div');
        host.innerHTML = '<p>Intro one</p><p>Loading spinner</p>';
        document.body.appendChild(host);
        live.push(new Translate(host, { category: 'UI', custom_id: 'pricing-hero' }));
        await vi.advanceTimersByTimeAsync(100);
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent.map((i) => [i.custom_id, (i.phrases ?? []).map((p) => p.phrase)])).toEqual([['pricing-hero', ['Intro one', 'Real content']]]);
    });
});

describe('SRV-5: what the observer leaves alone', () => {
    it('a text change (a value the framework updates) never re-keys the block', async () => {
        const host = mount('<p>Hello</p><p>You have 3 items</p>');
        await vi.advanceTimersByTimeAsync(1000);
        host.querySelector('p:last-child')!.firstChild!.nodeValue = 'You have 4 items';
        await vi.advanceTimersByTimeAsync(1000);
        expect(blocks()).toEqual([['Hello', 'You have 3 items']]);
    });

    it('its own writes: a locale switch translates without re-deriving', async () => {
        const id = generateCustomId('UI', ['A1', 'A2']);
        catalog({ [id]: { A1: 'Ae1', A2: 'Ae2' } });
        const host = mount('<p>A1</p><p>A2</p>');
        await vi.advanceTimersByTimeAsync(1000);
        catalog({ [id]: { A1: 'Af1', A2: 'Af2' } }, 'fr-fr');
        await vi.advanceTimersByTimeAsync(1000);
        expect(host.textContent).toBe('Af1Af2');
        expect(sent).toEqual([]);
        expect(host.getAttribute('data-ls-contentblock')).toBe(id);
    });

    it('a nested host’s own changes are its own', async () => {
        const host = mount('<p>A1</p><p>A2</p><section data-ls-contentblock><p>B1</p><p>B2</p></section>');
        await vi.advanceTimersByTimeAsync(1000);
        const outer = sent.filter((i) => i.custom_id === generateCustomId('UI', ['A1', 'A2']));
        const p = document.createElement('p');
        p.textContent = 'B3';
        host.querySelector('section')!.appendChild(p);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent.filter((i) => i.custom_id === generateCustomId('UI', ['A1', 'A2']))).toEqual(outer);
    });

    it('an adopted, served host is not observed', async () => {
        const host = document.createElement('div');
        host.setAttribute('data-ls-contentblock', 'served-id');
        host.setAttribute('data-ls-resolved', 'es-es');
        host.innerHTML = '<p>Uno</p><p>Dos</p>';
        document.body.appendChild(host);
        live.push(new Translate(host, { category: 'UI' }));
        await vi.advanceTimersByTimeAsync(100);
        host.appendChild(Object.assign(document.createElement('p'), { textContent: 'Tres' }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toEqual([]);
    });

    it('destroy() stops it', async () => {
        const host = mount('<p>Intro one</p><p>Loading spinner</p>');
        await vi.advanceTimersByTimeAsync(1000);
        live.pop()!.destroy();
        sent = [];
        resolveFallback(host, '<p>Real content</p>');
        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toEqual([]);
    });
});
