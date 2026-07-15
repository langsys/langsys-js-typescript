// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { Translate } from '../src/translate.js';
import { generateCustomId } from '../src/content-block.js';
import { sTranslations, currentlyLoadedLocale } from '../src/stores.js';

const PHRASE = 'Welcome to the demo store. Browse the catalog and check out in your language.';
const TRANSLATION = 'Bienvenido a la tienda de demostración. Explora el catálogo y haz tu compra en tu idioma.';

function hostWith(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
}

function resetStores(): void {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
    });
    currentlyLoadedLocale.set('es-ES');
}

async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Translate — single-token blocks', () => {
    beforeEach(resetStores);

    it('resolves a single-token block registered as a content block (hash entry)', async () => {
        // The regression: catalogs store content blocks as
        // cats[cat][custom_id] = { token: translation }, but the single-token
        // render path only consulted flat t() — so a registered-and-translated
        // block rendered its source text forever.
        const customId = generateCustomId('Tour', [PHRASE]);
        sTranslations.set({
            Tour: { __category__: 'Tour', __symbol__: 'Tour', [customId]: { [PHRASE]: TRANSLATION } },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });

        const el = hostWith(`<p>${PHRASE}</p>`);
        new Translate(el, { category: 'Tour' });
        await tick();

        expect(el.innerText).toBe(TRANSLATION);
    });

    it('falls back to the flat phrase catalog when no content-block entry exists', async () => {
        sTranslations.set({
            Tour: { __category__: 'Tour', __symbol__: 'Tour', [PHRASE]: TRANSLATION },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });

        const el = hostWith(`<p>${PHRASE}</p>`);
        new Translate(el, { category: 'Tour' });
        await tick();

        expect(el.innerText).toBe(TRANSLATION);
    });

    it('renders the source text when neither entry exists', async () => {
        const el = hostWith(`<p>${PHRASE}</p>`);
        new Translate(el, { category: 'Tour' });
        await tick();

        expect(el.innerText).toBe(PHRASE);
    });

    it('honors an explicit custom_id for single-token blocks', async () => {
        sTranslations.set({
            Tour: { __category__: 'Tour', __symbol__: 'Tour', 'my-hero-block': { [PHRASE]: TRANSLATION } },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });

        const el = hostWith(`<p>${PHRASE}</p>`);
        new Translate(el, { category: 'Tour', custom_id: 'my-hero-block' });
        await tick();

        expect(el.innerText).toBe(TRANSLATION);
    });

    it('re-renders from the content-block entry when the catalog arrives after parse', async () => {
        // Cold-cache order: the block parses against an empty catalog (source
        // text), then the fetch settles and currentlyLoadedLocale emits.
        const el = hostWith(`<p>${PHRASE}</p>`);
        new Translate(el, { category: 'Tour' });
        await tick();
        expect(el.innerText).toBe(PHRASE);

        const customId = generateCustomId('Tour', [PHRASE]);
        sTranslations.set({
            Tour: { __category__: 'Tour', __symbol__: 'Tour', [customId]: { [PHRASE]: TRANSLATION } },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        currentlyLoadedLocale.set('de-DE');
        await tick();

        expect(el.innerText).toBe(TRANSLATION);
    });
});
