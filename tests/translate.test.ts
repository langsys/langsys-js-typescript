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
