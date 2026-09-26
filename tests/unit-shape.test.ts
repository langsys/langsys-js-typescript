// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { NON_TRANSLATABLE_ELEMENTS } from '../src/identity.js';
import { LangsysApp } from '../src/langsys-app.js';
import { config as configStore, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * TOK-6: a unit registers as a phrase only when its one token is its one text node.
 *
 * "Its" text node means the unit's own. What the tokenizer leaves out of the unit —
 * code and notation, `translate="no"` and `data-notrans`, a phrase host, a nested block —
 * is not the unit's text, so it cannot make a one-token unit a block. Before one shared
 * predicate answered both questions, `<p>Hello <script>…</script></p>` tokenized to
 * `['Hello']` and still registered as a block, because the single-text-node search counted
 * the script's source as a second text node.
 */

type Item = { type: string; phrase?: string; phrases?: Array<{ phrase: string }> };
let sent: Item[] = [];
const live: Translate[] = [];
const settle = () => vi.advanceTimersByTimeAsync(600);

/**
 * Mount `html` as the content of a `<Translate>` host: the host is the wrapper, and
 * the unit is what it wraps, so the markup's own attributes are tokens. Returns the
 * host.
 */
function unit(html: string, catalog: Record<string, unknown> = {}): HTMLElement {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...catalog },
    } as never);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    live.push(new Translate(host, { category: 'UI' }));
    return host;
}
const blocks = () => sent.filter((i) => i.type === 'content_block').map((b) => (b.phrases ?? []).map((p) => p.phrase));
const phrases = () => sent.filter((i) => i.type === 'phrase').map((i) => i.phrase);

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k' });
    _resetDiscoveryState();
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

const LEFT_OUT: Array<[string, string]> = [
    ...NON_TRANSLATABLE_ELEMENTS.map((tag): [string, string] => [`<${tag}>`, `<${tag}>x = 1</${tag}>`]),
    ['translate="no"', '<span translate="no">ACME</span>'],
    ['data-notrans', '<span data-notrans>ACME</span>'],
    ['a phrase host (data-ls-phrase)', '<span data-ls-phrase>Kept <b>together</b></span>'],
    ['a phrase host (data-langsys-phrase)', '<span data-langsys-phrase>Kept <b>together</b></span>'],
];

describe('TOK-6: text left out of the unit does not change its shape', () => {
    it.each(LEFT_OUT)('one token beside %s registers as a phrase', async (_label, inner) => {
        const host = unit(`<p>Hello ${inner}</p>`);
        await settle();
        expect(tokenizeElement(host).tokens).toEqual(['Hello']);
        expect(phrases()).toContain('Hello');
        expect(blocks()).toEqual([]);
    });

    it('the translation is written into the unit’s text node, and what was left out is untouched', async () => {
        const host = unit('<p>Hello <script>track()</script><span translate="no">ACME</span></p>', { Hello: 'Hola' });
        await settle();
        const p = host.querySelector('p')!;
        expect(p.firstChild!.nodeValue).toBe('Hola');
        expect(p.querySelector('script')!.textContent).toBe('track()');
        expect(p.querySelector('span')!.textContent).toBe('ACME');
    });

    it('a block’s render walk leaves code alone even when its text matches a translation', async () => {
        // A block translates through its own catalog entry, keyed by its id.
        const id = generateCustomId('UI', ['One', 'Two']);
        const host = unit('<p>One</p><p>Two</p><style>One</style>', { [id]: { One: 'Uno', Two: 'Dos' } });
        await settle();
        expect(host.querySelectorAll('p')[0]!.textContent).toBe('Uno');
        expect(host.querySelector('style')!.textContent).toBe('One');
    });
});

describe('TOK-6: the shapes the rule names, as controls', () => {
    it('<p>Hello</p> is a phrase', async () => {
        unit('<p>Hello</p>');
        await settle();
        expect(phrases()).toEqual(['Hello']);
        expect(blocks()).toEqual([]);
    });

    it('<p>Hello <b>bold</b></p> is a block: two tokens', async () => {
        unit('<p>Hello <b>bold</b></p>');
        await settle();
        expect(blocks()).toEqual([['Hello', 'bold']]);
        expect(phrases()).toEqual([]);
    });

    it('<p title="Tooltip">Hello</p> is a block: an attribute token first', async () => {
        unit('<p title="Tooltip">Hello</p>');
        await settle();
        expect(blocks()).toEqual([['Tooltip', 'Hello']]);
    });

    it('a text node inside an ordinary child still counts: <p>Hello<span> there</span></p> is a block', async () => {
        unit('<p>Hello<span> there</span></p>');
        await settle();
        expect(blocks()).toEqual([['Hello', 'there']]);
    });
});
