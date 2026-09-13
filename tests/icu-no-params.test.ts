// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import { createSignal } from '../src/signal.js';
import { config as configStore, currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import { Translate } from '../src/translate.js';
import { Translations } from '../src/translations.js';

/**
 * ICU-1 and ICU-3 on the call paths, not only inside `interpolate`.
 *
 * Found by the JS Server lane, executed against a18e4a3: `t()` with no params returned
 * the raw ICU source, because it called `interpolate` only when params were supplied.
 * `<Translate>` had the same early return in `applyParams`, and a second one ahead of
 * it: at the base locale, a block with no params was not walked at all.
 * `interpolation-cross-impl` proves `interpolate` itself, and every row of the shared
 * interpolation fixture supplies params, so no suite in the fleet had a no-params case.
 *
 * The single-token test WITH params pins the hazard the fix creates. `<Translate>`
 * applied its params to `t()`'s result, so once `t()` renders ICU on its own, the select
 * has already collapsed to `other` before the params arrive. Measured on the naive fix:
 * `{g: 'female'}` rendered "They left", and the rest of the suite stayed green.
 */

const SELECT = '{g, select, male {He} female {She} other {They}} left';
const PLURAL = '{count, plural, one {# item} other {# items}}';
const PLAIN_WITH_BRACES = ["Don't stop", 'Price: {', '50% {off', 'a } b', '{}', '{ }', 'Use {{double}} braces', "'{literal}'", 'Hello {name}'];
const settle = () => new Promise((r) => setTimeout(r, 30));
const live: Translate[] = [];

type LooseT = (phrase: string, categoryOrParams?: string | Record<string, unknown>, params?: Record<string, unknown>) => string;
const looseT = () => new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en'), baseLocale: 'en' }).t as unknown as LooseT;

function seedUI(entries: Record<string, string> = {}) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
}

async function render(html: string, params?: Record<string, string | number>): Promise<HTMLElement> {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    live.push(new Translate(host, { category: 'UI', params }));
    await settle();
    return host;
}

beforeEach(() => {
    seedUI();
    currentlyLoadedLocale.set(configStore.baseLocale);
    LangsysApp.Translations.settle();
});

afterEach(() => {
    for (const t of live) t.destroy();
    live.length = 0;
    document.body.innerHTML = '';
});

describe('ICU-1: t() with no params renders ICU, not its source', () => {
    it('a select renders its other branch', () => {
        expect(looseT()(SELECT)).toBe('They left');
    });

    it('and so does the category overload', () => {
        expect(looseT()(SELECT, 'UI')).toBe('They left');
    });

    it('a plural with no count shows the argument name where # was (ICU-3)', () => {
        expect(looseT()(PLURAL, 'UI')).toBe('{count} items');
    });

    it('a catalog hit carrying ICU recovers the same way', () => {
        seedUI({ [SELECT]: '{g, select, male {Il est parti} female {Elle est partie} other {Ils sont partis}}' });
        expect(looseT()(SELECT, 'UI')).toBe('Ils sont partis');
    });

    it('control: supplied params still choose, in both overloads', () => {
        expect(looseT()(SELECT, { g: 'female' })).toBe('She left');
        expect(looseT()(PLURAL, 'UI', { count: 2 })).toBe('2 items');
    });

    it.each(PLAIN_WITH_BRACES)('plain text is left exactly as written: %s', (plain) => {
        expect(looseT()(plain, 'UI')).toBe(plain);
    });
});

describe('ICU-1: <Translate> with no params renders ICU, not its source', () => {
    it('a single-token host renders the other branch', async () => {
        expect((await render(`<p>${SELECT}</p>`)).textContent).toBe('They left');
    });

    it('a single-token host WITH params still chooses by them', async () => {
        expect((await render(`<p>${SELECT}</p>`, { g: 'female' })).textContent).toBe('She left');
    });

    it('a multi-token block at the base locale is walked, and renders the recovered plural', async () => {
        expect((await render(`<p>${PLURAL}</p><span>tail</span>`)).textContent).toBe('{count} itemstail');
    });

    it('control: the same block with a count renders the count', async () => {
        expect((await render(`<p>${PLURAL}</p><span>tail</span>`, { count: 3 })).textContent).toBe('3 itemstail');
    });

    it('an ICU attribute value renders its other branch', async () => {
        const host = await render(`<p>Profile</p><img alt="${SELECT}">`);
        expect(host.querySelector('img')!.getAttribute('alt')).toBe('They left');
    });

    it('control: a block with no ICU and no params at the base locale is left as written', async () => {
        expect((await render('<p>Hello {name}</p><span>tail</span>')).textContent).toBe('Hello {name}tail');
    });
});
