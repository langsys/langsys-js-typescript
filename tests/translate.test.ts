// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Translate } from '../src/translate.js';
import { LangsysApp } from '../src/langsys-app.js';
import { sTranslations, currentlyLoadedLocale } from '../src/stores.js';
import { generateCustomId } from '../src/content-block.js';
import type { iCategories } from '../src/types/translations.js';

/**
 * Two failures that look like "translations just don't show up".
 *
 * The element re-rendered on a LOCALE change and on nothing else, so a
 * same-locale catalog arrival — the first fetch completing, a `refresh()`, a
 * token-flush write-back — left the source text on screen with a correct
 * catalog sitting in the store.
 *
 * And a single-token block was rendered with `innerText`, which flattens the
 * subtree: the markup a framework component wraps its text in was destroyed on
 * first render, taking any `data-testid`, `id` or ref with it.
 */

const live: Translate[] = [];

function bare(): iCategories {
    return { __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } };
}

function make(html: string, options: ConstructorParameters<typeof Translate>[1] = {}) {
    const el = document.createElement('div');
    el.innerHTML = html;
    const t = new Translate(el, options);
    live.push(t);
    return { el, t };
}

beforeEach(() => {
    sTranslations.set(bare());
    currentlyLoadedLocale.set('en-us');
    // Nothing in these tests needs a catalog fetch; settle the gate so the
    // content-block path doesn't await forever.
    LangsysApp.Translations.settle();
});

afterEach(() => {
    live.forEach((t) => t.destroy());
    live.length = 0;
    sTranslations.set(bare());
});

describe('a catalog arriving without a locale change still re-renders', () => {
    it('re-renders when sTranslations is replaced at the same locale', async () => {
        const { el } = make('Welcome back.');
        await new Promise((r) => setTimeout(r, 0));

        expect(el.textContent).toBe('Welcome back.');

        // The first catalog lands. currentlyLoadedLocale never changes value,
        // so a locale-only subscription observes nothing at all.
        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                'Welcome back.': 'Bentornato.',
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(el.textContent).toBe('Bentornato.');
    });

    it('stops re-rendering after destroy()', async () => {
        const { el, t } = make('Welcome back.');
        await new Promise((r) => setTimeout(r, 0));
        t.destroy();

        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                'Welcome back.': 'Bentornato.',
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(el.textContent).toBe('Welcome back.');
    });
});

describe('an attribute-only token must not take the single-token fast path', () => {
    // The fast path assumes "one token" means "one text node". A translatable
    // ATTRIBUTE is also one token, and an element carrying only an attribute
    // token has no text node anywhere in its subtree — so writing the
    // translation as text replaces the element with a string, and the <img>
    // or <input> is gone.
    // The node-walking path resolves through the CONTENT-BLOCK entry keyed by
    // custom_id, not through flat phrases — so the catalog has to be seeded the
    // way the backend actually returns one, or these would fail for a reason
    // that has nothing to do with routing.
    function withBlock(tokens: string[], translations: Record<string, string>, category = '') {
        const customId = generateCustomId(category, tokens);
        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                'Welcome back.': 'Bentornato.',
                loading: 'cargando',
                [customId]: translations as unknown as string,
            },
        } as iCategories);
    }

    it('keeps the <img> and translates alt in place', async () => {
        withBlock(['Alt text'], { 'Alt text': 'Texto alt' });
        const { el } = make('<img alt="Alt text">');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('img')).not.toBeNull();
        expect(el.querySelector('img')?.getAttribute('alt')).toBe('Texto alt');
    });

    it('keeps the <input> and translates placeholder in place', async () => {
        withBlock(['Your name'], { 'Your name': 'Tu nombre' });
        const { el } = make('<input placeholder="Your name">');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('input')).not.toBeNull();
        expect(el.querySelector('input')?.getAttribute('placeholder')).toBe('Tu nombre');
    });

    it('reaches an attribute token on a NESTED element too', async () => {
        // The residual shape worth pinning: the token is one level down, so
        // whatever routes it has to recurse rather than only inspect children.
        withBlock(['Alt text'], { 'Alt text': 'Texto alt' });
        const { el } = make('<span><img alt="Alt text"></span>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('span > img')).not.toBeNull();
        expect(el.querySelector('img')?.getAttribute('alt')).toBe('Texto alt');
    });

    it('still uses the fast path for a genuine single TEXT token', async () => {
        // Regression guard. The fast path is correct for what it was built
        // for; this change narrows which content reaches it, not what it does.
        withBlock(['Welcome back.'], { 'Welcome back.': 'Bentornato.' });
        const { el } = make('<p data-testid="greeting">Welcome back.</p>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.textContent).toBe('Bentornato.');
        expect(el.querySelector('[data-testid="greeting"]')).not.toBeNull();
    });

    it('still preserves framework anchor comments', async () => {
        withBlock(['loading'], { loading: 'cargando' });
        const el = document.createElement('div');
        el.innerHTML = '<!--[-->loading<!--]-->';
        const t = new Translate(el, {});
        live.push(t);
        await new Promise((r) => setTimeout(r, 10));

        expect(el.textContent).toBe('cargando');
        expect(Array.from(el.childNodes).filter((n) => n.nodeType === 8)).toHaveLength(2);
    });

    it('a mixed text+attribute element is multi-token and walks nodes', async () => {
        withBlock(['Alt text', 'Welcome back.'], { 'Alt text': 'Texto alt', 'Welcome back.': 'Bentornato.' });
        const { el } = make('<img alt="Alt text">Welcome back.');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('img')?.getAttribute('alt')).toBe('Texto alt');
        expect(el.textContent).toContain('Bentornato.');
    });
});

describe('a single-token block keeps its markup', () => {
    it('writes into the text node instead of flattening the subtree', async () => {
        const { el } = make('<p data-testid="greeting">Welcome back.</p>');
        await new Promise((r) => setTimeout(r, 0));

        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                'Welcome back.': 'Bentornato.',
            },
        });
        await new Promise((r) => setTimeout(r, 0));

        expect(el.textContent).toBe('Bentornato.');
        // The wrapper, and the hook a test or a ref was holding, survive.
        expect(el.querySelector('p')).not.toBeNull();
        expect(el.querySelector('[data-testid="greeting"]')).not.toBeNull();
    });

    it('resolves from the content-block catalog, which flat t() cannot see into', async () => {
        const category = '';
        const tokens = ['Welcome back.'];
        const customId = generateCustomId(category, tokens);

        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                [customId]: { [tokens[0]]: 'Bentornato dal blocco.' } as unknown as string,
            },
        });

        const { el } = make('<p>Welcome back.</p>');
        await new Promise((r) => setTimeout(r, 0));

        expect(el.textContent).toBe('Bentornato dal blocco.');
    });
});
