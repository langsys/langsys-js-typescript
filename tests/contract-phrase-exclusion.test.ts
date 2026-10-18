// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"fetch":{"disableSameOriginPolicy":true}}}
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBlock, renderBlock, serializeTree, type BlockNode } from '../src/block-tree.js';
import { generateCustomId } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { Translate } from '../src/translate.js';
import { createSignal } from '../src/signal.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import canonicalization from './fixtures/canonicalization-reference.json';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';
import { resetSdk, until } from './helpers/sdk-session.js';

/**
 * TOK-1 in a rich phrase, graded against the contract double (spec CONF-2): an author's
 * `translate="no"` or `data-notrans` element, or code, is one markup pair with nothing
 * between, whatever it holds. Registration is read back from what the double stored, on
 * the DOM path (`Phrase`) and the tree path (`registerBlock` over a phrase host), for every
 * `phrase_cases` row of the shared fixture. Rendering restores the element's source content
 * as given, and a phrase registered under its earlier key renders that translation while
 * registering only its current key.
 */

interface PhraseCase {
    id: string;
    html: string;
    expected_phrase: string;
    registers: boolean;
    earlier_phrase?: string;
}

const ROWS = (canonicalization as unknown as { phrase_cases: PhraseCase[] }).phrase_cases;

let fx: ContractFixture;
const live: { destroy(): void }[] = [];

const PROJECT = { id: 'p1', base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local' };
type Seeded = { phrase: string; category?: string; translations?: Record<string, string> };
const seedWith = (phrases: Seeded[] = [], blocks: { category: string; custom_id: string; phrases: Seeded[] }[] = []) =>
    fx.seed({ projects: [{ ...PROJECT, phrases, blocks }], keys: [{ key: 'k-write', project: 'p1', type: 'write' }] });
const stored = async () => (await fx.state()).projects.p1.phrases.map((p) => p.phrase);
/** Whether this session's catalog holds the phrase: its registration has flushed. */
const heldLocally = (phrase: string) => Object.prototype.hasOwnProperty.call(sTranslations.get().UI ?? {}, phrase);

async function client() {
    resetSdk();
    await LangsysApp.init({ projectid: 'p1', key: 'k-write', UserLocaleStore: createSignal('es-es'), baseLocale: 'en', apiUrl: fx.baseUrl });
    await until(() => currentlyLoadedLocale.get() === 'es-es');
}

function mount(html: string): HTMLElement {
    const host = document.createElement('span');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}

/** The DOM's children as the tree a binding hands the tree path. */
function toTree(nodes: ArrayLike<ChildNode>): BlockNode[] {
    return Array.from(nodes).flatMap((node): BlockNode[] => {
        if (node.nodeType === 3) return [{ text: node.nodeValue ?? '' }];
        if (node.nodeType === 8) return [{ comment: node.nodeValue ?? '' }];
        if (node.nodeType !== 1) return [];
        const element = node as Element;
        const attrs = Object.fromEntries(Array.from(element.attributes, (a) => [a.name, a.value]));
        return [{ tag: element.tagName.toLowerCase(), attrs, children: toTree(element.childNodes) }];
    });
}

function phraseHost(html: string): BlockNode[] {
    const parsed = document.createElement('span');
    parsed.innerHTML = html;
    return [{ tag: 'span', attrs: { 'data-ls-phrase': true }, children: toTree(parsed.childNodes) }];
}

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    resetSdk();
    await fx.stop();
});
beforeEach(async () => {
    for (const m of ['log', 'info', 'warn', 'group', 'groupCollapsed', 'groupEnd', 'error'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    await seedWith();
});
afterEach(() => {
    for (const p of live) p.destroy();
    live.length = 0;
    document.body.innerHTML = '';
    resetSdk();
    vi.restoreAllMocks();
});

describe('every phrase_cases row registers its key, or nothing, through Phrase and through the tree path', () => {
    it('reads the thirteen rows', () => {
        expect(ROWS).toHaveLength(13);
    });

    const PATHS = ['Phrase', 'tree'] as const;
    const cases = ROWS.flatMap((row) => PATHS.map((path) => [`${row.id} (${path})`, row, path] as const));

    it.each(cases)('%s', async (_name, row, path) => {
        await client();
        if (path === 'Phrase') live.push(new Phrase(mount(row.html), { category: 'UI' }));
        else void registerBlock(phraseHost(row.html), { category: 'UI' });
        // A navigation re-enters every mounted phrase once it is ready; one with no text of
        // its own stays silent.
        await new Promise((resolve) => setTimeout(resolve, 50));
        LangsysApp.Translations.notifyNavigation();
        // The session writes: a control phrase mounted after it lands in the double.
        live.push(new Phrase(mount('A control sentence'), { category: 'UI' }));
        await until(async () => (await stored()).includes('A control sentence'));
        if (row.registers) await until(async () => (await stored()).includes(row.expected_phrase));

        const phrases = await stored();
        expect(phrases.includes(row.expected_phrase)).toBe(row.registers);
        // Nothing else reached the double: no earlier key, no second split. Where the element is
        // excluded, its value and code are in no phrase (the `data-notrans="false"` row is the
        // control, whose text is the phrase's own).
        expect(phrases.filter((p) => p !== 'A control sentence' && p !== row.expected_phrase)).toEqual([]);
        if (row.id !== 'tok1-rich-notrans-false') expect(phrases.join('\n')).not.toMatch(/a@b\.c|x\(\)/);
    });
});

it('a phrase made only of value markers stays silent on a navigation, as on mount (VAR-3)', async () => {
    await client();
    live.push(new Phrase(mount('<!--ls:name-->Ana<!--/ls-->'), { category: 'UI' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    LangsysApp.Translations.notifyNavigation();
    live.push(new Phrase(mount('A control sentence'), { category: 'UI' }));
    await until(async () => (await stored()).includes('A control sentence'));
    expect(await stored()).toEqual(['A control sentence']);
});

describe('an opaque element renders its source content as given', () => {
    const MARKED = 'Signed in as <span translate="no"><!--ls:email-->a@b.c<!--/ls--></span> today';

    it('in place: the element is the one the page rendered, and its content is untouched', async () => {
        await seedWith([{ phrase: 'Signed in as {m0o}{m0c} today', category: 'UI', translations: { 'es-es': 'Conectado como {m0o}{m0c} hoy' } }]);
        await client();
        const host = mount(MARKED);
        const span = host.querySelector('span')!;
        live.push(new Phrase(host, { category: 'UI' }));

        await until(() => host.textContent!.startsWith('Conectado'));
        expect(host.innerHTML).toBe('Conectado como <span translate="no"><!--ls:email-->a@b.c<!--/ls--></span> hoy');
        expect(host.querySelector('span')).toBe(span);
    });

    it('rebuilt: text a translation put inside the pair is dropped, and the element is still the page’s', async () => {
        await seedWith([{ phrase: 'Signed in as {m0o}{m0c} today', category: 'UI', translations: { 'es-es': 'Conectado como {m0o}correo{m0c} hoy' } }]);
        await client();
        const host = mount(MARKED);
        const span = host.querySelector('span')!;
        live.push(new Phrase(host, { category: 'UI' }));

        await until(() => host.textContent!.startsWith('Conectado'));
        expect(host.innerHTML).toBe('Conectado como <span translate="no"><!--ls:email-->a@b.c<!--/ls--></span> hoy');
        expect(host.querySelector('span')).toBe(span);
    });

    it('an element inside an opaque one takes no slot, so the next element renders in place', async () => {
        await seedWith([{ phrase: '{m0o}{m0c} and {m1o}y{m1c}', category: 'UI', translations: { 'es-es': '{m0o}{m0c} e {m1o}y{m1c}' } }]);
        await client();
        const host = mount('<span translate="no"><b>x</b></span> and <i>y</i>');
        const italic = host.querySelector('i')!;
        live.push(new Phrase(host, { category: 'UI' }));

        await until(() => host.textContent!.includes(' e '));
        expect(host.innerHTML).toBe('<span translate="no"><b>x</b></span> e <i>y</i>');
        expect(host.querySelector('i')).toBe(italic);
    });

    it('on the tree path, the rendered element holds its source nodes', async () => {
        await seedWith([{ phrase: 'Signed in as {m0o}{m0c} today', category: 'UI', translations: { 'es-es': 'Conectado como {m0o}correo{m0c} hoy' } }]);
        await client();
        const { nodes } = renderBlock(phraseHost(MARKED), { category: 'UI' });
        expect(serializeTree(nodes)).toBe(
            '<span data-ls-phrase data-ls-resolved="es-es">Conectado como <span translate="no"><!--ls:email-->a@b.c<!--/ls--></span> hoy</span>'
        );
    });
});

describe('a phrase registered under its earlier key renders that translation and registers only its current key', () => {
    const row = ROWS.find((r) => r.id === 'tok1-rich-earlier-key')!;
    const control = ROWS.find((r) => r.id === 'tok1-rich-earlier-key-control')!;
    const EARLIER = { phrase: row.earlier_phrase!, category: 'UI', translations: { 'es-es': 'Bienvenido a {m0o}Langsys{m0c}, {m1o}amigo{m1c}' } };

    it('the fixture gives the earlier key beside the current one, and the control’s key does not move', () => {
        expect(row.earlier_phrase).toBe('Welcome to {m0o}Langsys{m0c}, {m1o}friend{m1c}');
        expect(row.expected_phrase).toBe('Welcome to {m0o}{m0c}, {m1o}friend{m1c}');
        expect(control.earlier_phrase).toBe(control.expected_phrase);
    });

    it('Phrase: the earlier translation renders with the element restored from source, and only the current key registers', async () => {
        await seedWith([EARLIER]);
        await client();
        // The double forgets the earlier key, so a registration of it would now be stored.
        await seedWith();
        const host = mount(row.html);
        const span = host.querySelector('span')!;
        live.push(new Phrase(host, { category: 'UI' }));

        await until(() => host.textContent!.startsWith('Bienvenido'));
        expect(host.innerHTML).toBe('Bienvenido a <span translate="no">Langsys</span>, <b>amigo</b>');
        expect(host.querySelector('span')).toBe(span);
        await until(async () => (await stored()).includes(row.expected_phrase));
        expect(await stored()).not.toContain(row.earlier_phrase);
        // Its registration flushed, the current key is known with no translation, so the earlier one still renders.
        await until(() => heldLocally(row.expected_phrase));
        expect(host.innerHTML).toBe('Bienvenido a <span translate="no">Langsys</span>, <b>amigo</b>');
    });

    it('tree path: the earlier translation renders with the element restored from source, and only the current key registers', async () => {
        await seedWith([EARLIER]);
        await client();
        await seedWith();
        const tree = phraseHost(row.html);
        const { nodes } = renderBlock(tree, { category: 'UI' });
        expect(serializeTree(nodes)).toBe('<span data-ls-phrase data-ls-resolved="es-es">Bienvenido a <span translate="no">Langsys</span>, <b>amigo</b></span>');

        void registerBlock(tree, { category: 'UI' });
        await until(async () => (await stored()).includes(row.expected_phrase));
        expect(await stored()).not.toContain(row.earlier_phrase);
        await until(() => heldLocally(row.expected_phrase));
        expect(serializeTree(renderBlock(phraseHost(row.html), { category: 'UI' }).nodes)).toBe(
            '<span data-ls-phrase data-ls-resolved="es-es">Bienvenido a <span translate="no">Langsys</span>, <b>amigo</b></span>'
        );
    });

    it('a phrase with no translation anywhere renders its source, never marked resolved, once its registration has flushed (GATE-10)', async () => {
        await client();
        const html = 'Hello <b>new</b> world';
        void registerBlock(phraseHost(html), { category: 'UI' });
        await until(() => heldLocally('Hello {m0o}new{m0c} world'));
        expect(await stored()).toContain('Hello {m0o}new{m0c} world');
        expect(serializeTree(renderBlock(phraseHost(html), { category: 'UI' }).nodes)).toBe('<span data-ls-phrase>Hello <b>new</b> world</span>');
    });

    it('control: with the current key translated, the earlier one is not consulted', async () => {
        await seedWith([EARLIER, { phrase: row.expected_phrase, category: 'UI', translations: { 'es-es': 'Hola, {m0o}{m0c}, {m1o}amigo{m1c}' } }]);
        await client();
        const host = mount(row.html);
        live.push(new Phrase(host, { category: 'UI' }));

        await until(() => host.textContent!.startsWith('Hola'));
        expect(host.innerHTML).toBe('Hola, <span translate="no">Langsys</span>, <b>amigo</b>');
    });
});

describe('a caller’s param inside an author’s exclusion is filled as plain text; a block keeps excluded text as written', () => {
    const HTML = 'Write to <b translate="no">%email%</b> for help';
    const KEY = 'Write to {m0o}{m0c} for help';
    const params = { email: 'help@site.test' };

    it('Phrase, a miss: the address shows, and the key registered holds neither it nor the placeholder', async () => {
        await client();
        const host = mount(HTML);
        live.push(new Phrase(host, { category: 'UI', params }));

        await until(() => host.innerHTML.includes('help@site.test'));
        expect(host.innerHTML).toBe('Write to <b translate="no">help@site.test</b> for help');
        await until(async () => (await stored()).includes(KEY));
        expect((await stored()).join('\n')).not.toMatch(/help@site|email/);
    });

    it('Phrase, a hit: the address shows in the translation, and a changed param is filled from the source again', async () => {
        await seedWith([{ phrase: KEY, category: 'UI', translations: { 'es-es': 'Escribe a {m0o}{m0c} para ayuda' } }]);
        await client();
        const host = mount(HTML);
        const phrase = new Phrase(host, { category: 'UI', params });
        live.push(phrase);

        await until(() => host.textContent!.startsWith('Escribe'));
        expect(host.innerHTML).toBe('Escribe a <b translate="no">help@site.test</b> para ayuda');
        phrase.setParams({ email: 'desk@site.test' });
        expect(host.innerHTML).toBe('Escribe a <b translate="no">desk@site.test</b> para ayuda');
    });

    it('the server renderer, a miss and a hit', async () => {
        await client();
        expect(serializeTree(renderBlock(phraseHost(HTML), { category: 'UI', params }).nodes)).toBe(
            '<span data-ls-phrase>Write to <b translate="no">help@site.test</b> for help</span>'
        );
        await seedWith([{ phrase: KEY, category: 'UI', translations: { 'es-es': 'Escribe a {m0o}{m0c} para ayuda' } }]);
        await client();
        expect(serializeTree(renderBlock(phraseHost(HTML), { category: 'UI', params }).nodes)).toBe(
            '<span data-ls-phrase data-ls-resolved="es-es">Escribe a <b translate="no">help@site.test</b> para ayuda</span>'
        );
    });

    it('a value fills as it prints elsewhere: %name% as {name}, a boolean as true or false, a number its digits; a date, a null and code stay as written', async () => {
        await client();
        const fill = { email: 'ana@example.com', on: true, off: false, count: 3, ratio: 2.5, when: new Date('2026-10-14T12:00:00Z'), other: null } as never;
        const inner = '%email% {on} {off} {count} {ratio} {when} %when% {other} <i>{email}</i><math><mi>{on}</mi></math><noscript>{on}</noscript>';
        const filled = 'ana@example.com true false 3 2.5 {when} %when% {other} <i>ana@example.com</i><math><mi>{on}</mi></math><noscript>{on}</noscript>';
        const host = mount(`Write to <b translate="no">${inner}<template>{on}</template></b> for help`);
        live.push(new Phrase(host, { category: 'UI', params: fill }));

        await until(() => host.innerHTML.includes('ana@example.com'));
        expect(host.innerHTML).toBe(`Write to <b translate="no">${filled}<template>{on}</template></b> for help`);
        expect(serializeTree(renderBlock(phraseHost(`Write to <b translate="no">${inner}</b> for help`), { category: 'UI', params: fill }).nodes)).toBe(
            `<span data-ls-phrase>Write to <b translate="no">${filled}</b> for help</span>`
        );
    });

    it('code is never filled, inside a phrase or an exclusion', async () => {
        await client();
        const host = mount('Run <script>var a = "{email}";</script> or <b translate="no">%email% <style>.x{email}</style></b> now');
        live.push(new Phrase(host, { category: 'UI', params }));

        await until(() => host.innerHTML.includes('help@site.test'));
        expect(host.innerHTML).toBe('Run <script>var a = "{email}";</script> or <b translate="no">help@site.test <style>.x{email}</style></b> now');
    });

    it('a phrase holding a marked value, served as source on a miss, fills the exclusion as its render does', async () => {
        // Found by the Svelte lane: the tree path served the source as given and left the placeholder.
        await client();
        const MARKED = 'Hi <!--ls:user_name-->Ana<!--/ls-->, <i>write to <b translate="no">%name% {name}</b></i> <math><mi translate="no">{name}</mi></math><script>var a = "%name%";</script>';
        const fill = { user_name: 'Ana', name: 'NICK' };
        expect(serializeTree(renderBlock(phraseHost(MARKED), { category: 'UI', params: fill }).nodes)).toBe(
            '<span data-ls-phrase>Hi <!--ls:user_name-->Ana<!--/ls-->, <i>write to <b translate="no">NICK NICK</b></i> <math><mi translate="no">{name}</mi></math><script>var a = "%name%";</script></span>'
        );

        // The DOM path is the control.
        const host = mount(MARKED);
        live.push(new Phrase(host, { category: 'UI', params: fill }));
        await until(() => host.innerHTML.includes('NICK'));
        expect(host.innerHTML).toContain('<i>write to <b translate="no">NICK NICK</b></i> <math><mi translate="no">{name}</mi></math><script>var a = "%name%";</script>');
    });

    describe('control: a block keeps an excluded element’s text exactly as written, params or not', () => {
        const BLOCK = '<p>Use <code translate="no">{name}</code> in templates</p><p>Write it as shown</p>';
        const TOKENS = ['Use', 'in templates', 'Write it as shown'];
        const seedBlock = () =>
            seedWith([], [
                {
                    category: 'UI',
                    custom_id: generateCustomId('UI', TOKENS),
                    phrases: [
                        { phrase: 'Use', translations: { 'es-es': 'Usa' } },
                        { phrase: 'in templates', translations: { 'es-es': 'en plantillas' } },
                        { phrase: 'Write it as shown', translations: { 'es-es': 'Escríbelo como se muestra' } },
                    ],
                },
            ]);

        it('Translate', async () => {
            await seedBlock();
            await client();
            const host = document.createElement('div');
            host.innerHTML = BLOCK;
            document.body.appendChild(host);
            live.push(new Translate(host, { category: 'UI', params: { name: 'Ana' } }));

            await until(() => host.textContent!.includes('Usa'));
            expect(host.innerHTML).toBe('<p>Usa <code translate="no">{name}</code> en plantillas</p><p>Escríbelo como se muestra</p>');
        });

        it('the tree path', async () => {
            await seedBlock();
            await client();
            const parsed = document.createElement('div');
            parsed.innerHTML = BLOCK;
            expect(serializeTree(renderBlock(toTree(parsed.childNodes), { category: 'UI', params: { name: 'Ana' } }).nodes)).toBe(
                '<p>Usa <code translate="no">{name}</code> en plantillas</p><p>Escríbelo como se muestra</p>'
            );
        });
    });
});
