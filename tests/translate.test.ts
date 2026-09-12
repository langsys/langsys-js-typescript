// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Translate } from '../src/translate.js';
import { LangsysApp } from '../src/langsys-app.js';
import { sTranslations, currentlyLoadedLocale } from '../src/stores.js';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
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

    it('reaches an attribute token TWO levels down', async () => {
        withBlock(['Alt text'], { 'Alt text': 'Texto alt' });
        const { el } = make('<div><div><img alt="Alt text"></div></div>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('div > div > img')).not.toBeNull();
        expect(el.querySelector('img')?.getAttribute('alt')).toBe('Texto alt');
    });

    it('handles an attribute token surrounded by whitespace-only text nodes', async () => {
        // Whitespace nodes are not tokens and must not be mistaken for the
        // single text node the fast path needs — otherwise this shape routes
        // to the fast path and the <img> is replaced by a whitespace write.
        withBlock(['Alt text'], { 'Alt text': 'Texto alt' });
        const { el } = make('  <img alt="Alt text">  ');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('img')?.getAttribute('alt')).toBe('Texto alt');
        expect(el.textContent).toBe('    ');
    });

    it('translates two attributes on one element', async () => {
        withBlock(['Alt text', 'Other'], { 'Alt text': 'Texto alt', Other: 'Otro' });
        const { el } = make('<img alt="Alt text" title="Other">');
        await new Promise((r) => setTimeout(r, 10));

        const img = el.querySelector('img');
        expect(img?.getAttribute('alt')).toBe('Texto alt');
        expect(img?.getAttribute('title')).toBe('Otro');
    });

    it('translates <option> text without losing the <select>', async () => {
        withBlock(['Pick'], { Pick: 'Elige' });
        const { el } = make('<select><option>Pick</option></select>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('select > option')).not.toBeNull();
        expect(el.querySelector('option')?.textContent).toBe('Elige');
    });

    it('translates an aria-label and the element text together', async () => {
        withBlock(['Close', 'x'], { Close: 'Cerrar', x: 'X' });
        const { el } = make('<a href="#" aria-label="Close">x</a>');
        await new Promise((r) => setTimeout(r, 10));

        const a = el.querySelector('a');
        expect(a?.getAttribute('aria-label')).toBe('Cerrar');
        expect(a?.textContent).toBe('X');
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

describe('the host element publishes its content-block id', () => {
    // A server-rendered page is otherwise unreadable: the id is derivable only
    // by re-running the tokenizer over the same subtree, which a reader holding
    // just the HTML cannot do identically. Mirrors how a Phrase host carries
    // PHRASE_MARKER_ATTR.
    it('stamps the id the tokenizer derives for that subtree', async () => {
        sTranslations.set(bare());
        const { el } = make('<p>First</p><p>Second</p>');
        await new Promise((r) => setTimeout(r, 10));

        const expected = generateCustomId('', tokenizeElement(elClone('<p>First</p><p>Second</p>')).tokens);
        expect(el.getAttribute('data-ls-contentblock')).toBe(expected);
    });

    it('stamps a single-token block too', async () => {
        sTranslations.set(bare());
        const { el } = make('<p>Only</p>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.getAttribute('data-ls-contentblock')).toBe(
            generateCustomId('', tokenizeElement(elClone('<p>Only</p>')).tokens)
        );
    });

    it('honours a caller-supplied custom_id rather than inventing one', async () => {
        sTranslations.set(bare());
        const { el } = make('<p>First</p><p>Second</p>', { custom_id: 'caller-chose-this' });
        await new Promise((r) => setTimeout(r, 10));

        expect(el.getAttribute('data-ls-contentblock')).toBe('caller-chose-this');
    });

    it('control: the id is not a constant — different content, different stamp', async () => {
        // Without this, "equals the derived id" is satisfied by stamping any
        // fixed string, since the expectation is computed the same way.
        sTranslations.set(bare());
        const a = make('<p>Alpha</p>');
        const b = make('<p>Beta</p>');
        await new Promise((r) => setTimeout(r, 10));

        const idA = a.el.getAttribute('data-ls-contentblock');
        const idB = b.el.getAttribute('data-ls-contentblock');
        expect(idA).toBeTruthy();
        expect(idA).not.toBe(idB);
    });
});

/** A detached host carrying the same markup, for deriving the expected id. */
function elClone(html: string): HTMLElement {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
}

describe('TOK-1 at 8.0.1 — svg text translates in place, geometry survives', () => {
    /**
     * The rule's third svg clause: "translating svg text replaces the text NODE in
     * place, never the svg element's content or structure, so its `<path>`
     * geometry survives."
     *
     * This is the render half, and it needs a real render rather than a token
     * comparison — the failure it guards against is a writer that flattens a
     * subtree while producing correct TOKENS. Same defect class as the
     * single-token `innerText` path above, which destroyed markup while agreeing
     * about every string in it.
     *
     * BE PRECISE ABOUT WHICH MUTANT EACH HALF CATCHES, measured by the Reviewer:
     * a walker writing `textContent` on the NEAREST element reds the inline-icon
     * test but NOT the standalone one — `<path>` is a sibling of `<text>`, so
     * writing on `<text>` is not destructive there. The standalone assertion is
     * pinned against a HOST-level write (the single-token fast path writing the
     * whole element), which reds 5. So "nearest element" is the right description
     * of the walker mutant only; don't strengthen the standalone test against a
     * mutant it was never the control for.
     */
    function withBlock(tokens: string[], translations: Record<string, string>, category = '') {
        const customId = generateCustomId(category, tokens);
        sTranslations.set({
            ...bare(),
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                [customId]: translations as unknown as string,
            },
        } as iCategories);
    }

    it('translates the svg <text> and leaves the <path> intact', async () => {
        const tokens = ['Click', 'go', 'to continue'];
        withBlock(tokens, { Click: 'Clic', go: 'ir', 'to continue': 'para continuar' });
        const { el } = make('<p>Click <svg><text>go</text><path d="M0 0L8 8"/></svg> to continue</p>');
        await new Promise((r) => setTimeout(r, 10));

        // The words changed…
        expect(el.querySelector('text')?.textContent).toBe('ir');
        expect(el.textContent).toContain('Clic');
        expect(el.textContent).toContain('para continuar');

        // …and the drawing did not. `d` is the assertion that matters: a writer
        // that rebuilt the subtree from strings would keep a <path> with no
        // geometry, or no <path> at all.
        const path = el.querySelector('path');
        expect(path, 'the <path> must survive translation').not.toBeNull();
        expect(path?.getAttribute('d')).toBe('M0 0L8 8');
        expect(el.querySelector('svg')).not.toBeNull();
    });

    it('a standalone svg keeps both its <path> and its <text> after translation', async () => {
        // The rule names this case separately from the inline-icon one, and it is
        // the stricter of the two: with no sibling prose, a single-token fast path
        // is reachable, which is exactly where markup gets destroyed.
        withBlock(['go'], { go: 'ir' });
        const { el } = make('<svg><text>go</text><path d="M1 1L2 2"/></svg>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('text')?.textContent).toBe('ir');
        expect(el.querySelector('path')?.getAttribute('d')).toBe('M1 1L2 2');
    });

    it('and <math> contributes nothing to render, so its notation is untouched', async () => {
        // The exclusion's render-side consequence: no token means no write, so the
        // expression survives verbatim rather than being "translated" in place.
        withBlock(['Area', 'units'], { Area: 'Area', units: 'unidades' });
        const { el } = make('<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>');
        await new Promise((r) => setTimeout(r, 10));

        expect(el.querySelector('math')?.textContent).toBe('x+2');
        expect(el.querySelector('mo')?.textContent).toBe('+');
        expect(el.textContent).toContain('unidades');
    });
});
