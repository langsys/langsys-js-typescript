// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { isHostManaged } from '../src/hosts.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { encodeRichText } from '../src/richtext.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * MARK-2 and MARK-3: a marked host inside a walked unit is a unit of its own (MARK-4),
 * and it must still become one. An enclosing walk that meets a marked host no instance
 * manages — server-rendered markup, a vanilla page — takes it over:
 *
 * - a phrase host registers whole, as the one string its markup defines (MARK-2);
 * - a bare, empty, `true`, `1` or `yes` block marker declares a block, registered under the
 *   id its tokens derive (MARK-3);
 * - any other value is a stamped identity: the host renders from the catalog entry under it,
 *   or its source text, and registers nothing (MARK-3);
 * - `false` and `0` opt out, and the element is ordinary markup.
 */

type Item = { type: string; phrase?: string; custom_id?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Array<{ destroy(): void }> = [];
const settle = () => vi.advanceTimersByTimeAsync(600);

function catalog(entries: Record<string, unknown> = {}) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
}
function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}
function translate(el: Element): Translate {
    const t = new Translate(el as HTMLElement, { category: 'UI' });
    live.push(t);
    return t;
}
const blocks = () => sent.filter((i) => i.type === 'content_block');
const blockWords = () => blocks().map((b) => (b.phrases ?? []).map((p) => p.phrase));
const phrases = () => sent.filter((i) => i.type === 'phrase').map((i) => i.phrase);
const INNER_ID = generateCustomId('UI', ['B1', 'B2']);

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    catalog();
    currentlyLoadedLocale.set('es-es');
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

const SPELLINGS = ['data-ls-contentblock', 'data-langsys-contentblock'];
const nested = (attr: string, value: string | null) =>
    `<p>A1</p><p>A2</p><section ${value === null ? attr : `${attr}="${value}"`}><p>B1</p><p>B2</p></section>`;

describe('MARK-3: a declaration registers the host as its own block, under the id its tokens derive', () => {
    const DECLARATIONS: Array<string | null> = [null, '', 'true', '1', 'YES', ' yes '];
    for (const attr of SPELLINGS) {
        it.each(DECLARATIONS.map((v) => [v === null ? 'bare' : JSON.stringify(v), v] as const))(`${attr} %s`, async (_label, value) => {
            const host = mount(nested(attr, value));
            translate(host);
            await settle();
            expect(blockWords()).toContainEqual(['B1', 'B2']);
            expect(blockWords()).toContainEqual(['A1', 'A2']);
            expect(blockWords().flat().filter((w) => w === 'B1'), 'B1 registers once').toHaveLength(1);
            expect(blocks().find((b) => b.phrases?.[0]?.phrase === 'B1')!.custom_id).toBe(INNER_ID);
            expect(host.querySelector('section')!.getAttribute('data-ls-contentblock')).toBe(INNER_ID);
        });
    }
});

describe('MARK-3: false and 0 opt out, and the element is ordinary markup', () => {
    for (const attr of SPELLINGS) {
        it.each(['0', 'false', ' FALSE '])(`${attr}=%j`, async (value) => {
            const host = mount(nested(attr, value));
            translate(host);
            await settle();
            expect(blockWords()).toEqual([['A1', 'A2', 'B1', 'B2']]);
        });
    }
});

describe('MARK-3: any other value is an identity: rendered under that id, nothing registered', () => {
    for (const attr of SPELLINGS) {
        it(`${attr}="abc123" renders the catalog entry under abc123`, async () => {
            catalog({ abc123: { B1: 'Uno', B2: 'Dos' } });
            const host = mount(nested(attr, 'abc123'));
            translate(host);
            await settle();
            const ps = host.querySelectorAll('section p');
            expect([ps[0]!.textContent, ps[1]!.textContent]).toEqual(['Uno', 'Dos']);
            expect(blockWords()).toEqual([['A1', 'A2']]);
            expect(phrases()).toEqual([]);
        });

        it(`${attr}="abc123" with no catalog entry keeps its source text and registers nothing`, async () => {
            const host = mount(nested(attr, 'abc123'));
            translate(host);
            await settle();
            expect(host.querySelector('section p')!.textContent).toBe('B1');
            expect(blockWords()).toEqual([['A1', 'A2']]);
        });
    }

    it('a Translate constructed on a stamped host adopts the stamp, and a single token does not become a phrase', async () => {
        catalog({ abc123: { Hello: 'Hola' } });
        const host = mount('<p data-ls-contentblock="abc123">Hello</p>');
        translate(host.firstElementChild!);
        await settle();
        expect(host.querySelector('p')!.textContent).toBe('Hola');
        expect(sent).toEqual([]);
    });

    it('a stamped single-token host with no catalog entry keeps its source and registers no phrase', async () => {
        const host = mount('<p data-langsys-contentblock="abc123">Hello</p>');
        translate(host.firstElementChild!);
        await settle();
        expect(host.querySelector('p')!.textContent).toBe('Hello');
        expect(sent).toEqual([]);
    });

    it('control: this SDK’s own stamp, on a host re-mounted in the same session, is not a renderer’s identity', async () => {
        // The framework re-renders the same element with new content: adopting the old
        // stamp would keep rendering under the old id and register nothing new.
        const host = mount('<p>R1</p><p>R2</p>');
        const first = translate(host);
        await settle();
        first.destroy();
        expect(host.getAttribute('data-ls-contentblock')).toBe(generateCustomId('UI', ['R1', 'R2']));
        host.innerHTML = '<p>S1</p><p>S2</p>';
        sent = [];
        translate(host);
        await settle();
        expect(blocks().map((b) => b.custom_id)).toEqual([generateCustomId('UI', ['S1', 'S2'])]);
    });
});

describe('MARK-2: an unmanaged phrase host registers whole, as the one string its host defines', () => {
    for (const attr of ['data-ls-phrase', 'data-langsys-phrase']) {
        it(`${attr}, met by an enclosing walk`, async () => {
            const host = mount(`<p>A1</p><p>A2</p><p ${attr}>Based on {n} <strong>reviews</strong></p>`);
            const expected = encodeRichText(host.querySelector('p:last-child') as HTMLElement).phrase;
            translate(host);
            await settle();
            expect(phrases()).toEqual([expected]);
            expect(blockWords()).toEqual([['A1', 'A2']]);
            expect(blockWords().flat()).not.toContain('reviews');
        });
    }

    it('a managed phrase host registers once: the walk does not take it over', async () => {
        const host = mount('<p>A1</p><p>A2</p><span data-ls-phrase>Kept <b>together</b></span>');
        live.push(new Phrase(host.querySelector('span')! as HTMLElement, { category: 'UI' }));
        translate(host);
        await settle();
        expect(phrases()).toHaveLength(1);
    });

    it('an instance the author constructs after the walk replaces the walk’s, and the phrase still registers once', async () => {
        const host = mount('<p>A1</p><p>A2</p><span data-ls-phrase>Kept <b>together</b></span>');
        translate(host);
        const span = host.querySelector('span')! as HTMLElement;
        expect(isHostManaged(span)).toBe(true);
        live.push(new Phrase(span, { category: 'UI' }));
        await settle();
        expect(phrases()).toHaveLength(1);
    });

    it('the walk’s instance stops when the author’s replaces it', async () => {
        const host = mount('<p>A1</p><p>A2</p><span data-ls-phrase>Hello {name}</span>');
        translate(host);
        await settle();
        const span = host.querySelector('span')! as HTMLElement;
        const authors = new Phrase(span, { category: 'UI', params: { name: 'Ada' } });
        catalog({ 'Hello {name}': 'Hola {name}' });
        await settle();
        expect(span.textContent).toBe('Hola Ada');
        authors.destroy();
        // Nothing manages the host now. Had the walk's instance survived, it would
        // re-render this catalog with its own (empty) params.
        catalog({ 'Hello {name}': 'Buenas {name}' });
        await settle();
        expect(span.textContent).toBe('Hola Ada');
    });

    it('a phrase host inside an excluded subtree is not taken over', async () => {
        const host = mount('<p>A1</p><p>A2</p><div translate="no"><span data-ls-phrase>Brand <b>name</b></span></div>');
        translate(host);
        await settle();
        expect(phrases()).toEqual([]);
        expect(isHostManaged(host.querySelector('span')!)).toBe(false);
    });

    it('destroying the enclosing instance releases what it took over', async () => {
        const host = mount(nested('data-ls-contentblock', null) + '<span data-ls-phrase>Kept <b>together</b></span>');
        const outer = translate(host);
        await settle();
        expect(isHostManaged(host.querySelector('section')!)).toBe(true);
        expect(isHostManaged(host.querySelector('span')!)).toBe(true);
        outer.destroy();
        expect(isHostManaged(host.querySelector('section')!)).toBe(false);
        expect(isHostManaged(host.querySelector('span')!)).toBe(false);
    });
});
