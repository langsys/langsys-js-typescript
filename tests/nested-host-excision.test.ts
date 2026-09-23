// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * MARK-4: a marked host inside a walked unit is excised.
 *
 * An element carrying a phrase marker, or a content-block marker that is not an opt-out
 * (MARK-3: a stamped id, a bare declaration, `true`, anything but `false`/`0`), contributes no
 * tokens to the enclosing unit. It is a unit of its own. Without this a `<Translate>` inside a
 * `<Translate>` folded the inner block's words into the outer block, so the same words
 * registered twice and the outer id depended on the inner content.
 *
 * Nested hosts here are constructed before the enclosing one, the order every component
 * framework mounts in: a `Translate` stamps its host while it is being constructed, so the
 * enclosing walk finds the stamp.
 */

type Item = { type: string; phrase?: string; custom_id?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Array<{ destroy(): void }> = [];
const settle = () => vi.advanceTimersByTimeAsync(600);

function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}
function translate(el: Element): void {
    live.push(new Translate(el as HTMLElement, { category: 'UI' }));
}
const blocks = () => sent.filter((i) => i.type === 'content_block');
const phrases = () => sent.filter((i) => i.type === 'phrase').map((i) => i.phrase);
const blockWords = () => blocks().flatMap((b) => (b.phrases ?? []).map((p) => p.phrase));

beforeEach(() => {
    // Phrase registration sends only for a configured project, as after init().
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI' },
    } as never);
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

describe('MARK-4: nested marked hosts contribute nothing to the enclosing unit', () => {
    it('a nested block host and a nested phrase host: the outer holds neither, and each registers once, on its own', async () => {
        const host = mount('<p>A1</p><p>A2</p><section><p>B1</p><p>B2</p></section><span data-ls-phrase>Kept together</span>');
        translate(host.querySelector('section')!);
        live.push(new Phrase(host.querySelector('span')! as HTMLElement, { category: 'UI' }));
        translate(host);
        await settle();

        expect(tokenizeElement(host).tokens).toEqual(['A1', 'A2']);
        expect(blocks().map((b) => (b.phrases ?? []).map((p) => p.phrase))).toEqual([['B1', 'B2'], ['A1', 'A2']]);
        expect(blockWords().filter((w) => w === 'B1'), 'B1 registers in one block only').toHaveLength(1);
        expect(phrases().filter((p) => p === 'Kept together'), 'the phrase host registers once, as a phrase').toHaveLength(1);
        expect(blockWords()).not.toContain('Kept together');
    });

    it('control: a block marker set to "false" is walked as ordinary markup, and its text folds in', () => {
        const host = mount('<p>A1</p><section data-ls-contentblock="false"><p>B1</p></section>');
        expect(tokenizeElement(host).tokens).toEqual(['A1', 'B1']);
    });

    it.each([
        ['a stamped id', 'data-ls-contentblock="0f3c9a"'],
        ["PHP's spelling", 'data-langsys-contentblock="0f3c9a"'],
        ['a bare declaration', 'data-langsys-contentblock'],
        ['an empty value', 'data-ls-contentblock=""'],
        ['true', 'data-langsys-contentblock="true"'],
    ])('excises %s', (_label, attr) => {
        const host = mount(`<p>A1</p><section ${attr}><p>B1</p></section>`);
        expect(tokenizeElement(host).tokens).toEqual(['A1']);
    });

    it.each([
        ['"0"', 'data-ls-contentblock="0"'],
        ['" FALSE ", trimmed and case-insensitive', 'data-langsys-contentblock=" FALSE "'],
    ])('does not excise an opt-out: %s', (_label, attr) => {
        const host = mount(`<p>A1</p><section ${attr}><p>B1</p></section>`);
        expect(tokenizeElement(host).tokens).toEqual(['A1', 'B1']);
    });

    it("moves the enclosing block's id: it no longer depends on the nested block's content", async () => {
        const host = mount('<p>A1</p><p>A2</p><section><p>B1</p><p>B2</p></section>');
        translate(host.querySelector('section')!);
        translate(host);
        await settle();
        expect(host.getAttribute('data-ls-contentblock')).toBe(generateCustomId('UI', ['A1', 'A2']));
        expect(host.getAttribute('data-ls-contentblock')).not.toBe(generateCustomId('UI', ['A1', 'A2', 'B1', 'B2']));
    });
});

describe('MARK-4 on the render path: the enclosing block does not write into a nested one', () => {
    it("each block renders its own translation, and an outer re-render leaves the inner's in place", async () => {
        const host = mount('<p>A1</p><p>A2</p><section><p>B1</p><p>B2</p></section>');
        const inner = host.querySelector('section')!;
        sTranslations.set({
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
            UI: {
                __category__: 'UI',
                __symbol__: 'UI',
                [generateCustomId('UI', ['B1', 'B2'])]: { B1: 'Be uno', B2: 'Be dos' },
                [generateCustomId('UI', ['A1', 'A2'])]: { A1: 'A uno', A2: 'A dos' },
            },
        } as never);
        translate(inner);
        translate(host);
        await settle();
        expect(inner.textContent).toBe('Be unoBe dos');
        expect(host.querySelector('p')!.textContent).toBe('A uno');

        sTranslations.set({ ...sTranslations.get() });
        await settle();
        expect(inner.textContent, 'the outer walk did not overwrite the inner block').toBe('Be unoBe dos');
    });
});

describe('TOK-6 with a nested block: the unit is what remains after excision', () => {
    it('one own text node beside a nested block registers as a phrase, not as a one-token block', async () => {
        const host = mount('Intro <section><p>Inner one</p><p>Inner two</p></section>');
        translate(host.querySelector('section')!);
        translate(host);
        await settle();
        expect(phrases()).toContain('Intro');
        expect(blocks().map((b) => (b.phrases ?? []).map((p) => p.phrase))).toEqual([['Inner one', 'Inner two']]);
    });
});
