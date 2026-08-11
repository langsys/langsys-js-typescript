// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    generateCustomId,
    isContentBlockKnown,
    registerContentBlock,
    tokenizeElement,
} from '../src/content-block.js';
import { LangsysAppAPI } from '../src/api.js';
import { logger } from '../src/logger.js';
import { config, sTranslations } from '../src/stores.js';
import type { iCategories } from '../src/types/translations.js';

const EMPTY: iCategories = {
    __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
};

function mount(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}

beforeEach(() => {
    sTranslations.set({ ...EMPTY });
    config.key_type = 'read';
    config.debug = false;
});

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('generateCustomId', () => {
    it('is deterministic for the same category and tokens', () => {
        expect(generateCustomId('nav', ['Home', 'About'])).toBe(generateCustomId('nav', ['Home', 'About']));
    });

    it('varies with the category', () => {
        expect(generateCustomId('nav', ['Home'])).not.toBe(generateCustomId('footer', ['Home']));
    });

    it('varies with token order', () => {
        expect(generateCustomId('nav', ['Home', 'About'])).not.toBe(generateCustomId('nav', ['About', 'Home']));
    });

    it('does not collide when a token contains the old join separator', () => {
        // Regression: `tokens.join('-')` made ['e-mail'] and ['e','mail']
        // hash identically. JSON delimits each token unambiguously.
        expect(generateCustomId('form', ['e-mail'])).not.toBe(generateCustomId('form', ['e', 'mail']));
    });

    it('distinguishes an empty token list from a single empty token', () => {
        expect(generateCustomId('nav', [])).not.toBe(generateCustomId('nav', ['']));
    });

    it('returns a stable md5-shaped id', () => {
        expect(generateCustomId('nav', ['Home'])).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('isContentBlockKnown', () => {
    it('is false when the category is absent from the cache', () => {
        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
    });

    it('is false when the category exists but the block does not', () => {
        sTranslations.set({
            ...EMPTY,
            nav: { __category__: 'nav', __symbol__: 'nav' },
        } as unknown as iCategories);

        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
    });

    it('is true once the block is present as an object', () => {
        sTranslations.set({
            ...EMPTY,
            nav: { __category__: 'nav', __symbol__: 'nav', abc123: {} },
        } as unknown as iCategories);

        expect(isContentBlockKnown('nav', 'abc123')).toBe(true);
    });

    it('falls back to __uncategorized__ for an empty category', () => {
        sTranslations.set({
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                abc123: {},
            },
        } as unknown as iCategories);

        expect(isContentBlockKnown('', 'abc123')).toBe(true);
    });

    it('is false when the cached entry is a plain string (a phrase, not a block)', () => {
        sTranslations.set({
            ...EMPTY,
            nav: { __category__: 'nav', __symbol__: 'nav', abc123: 'Inicio' },
        } as unknown as iCategories);

        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
    });
});

describe('tokenizeElement — token harvesting', () => {
    it('collects text-node content', () => {
        expect(tokenizeElement(mount('<p>Hello</p><p>Goodbye</p>')).tokens).toEqual(['Hello', 'Goodbye']);
    });

    it('normalizes whitespace and trims', () => {
        expect(tokenizeElement(mount('<p>  Hello\n   world  </p>')).tokens).toEqual(['Hello world']);
    });

    it('drops whitespace-only text nodes', () => {
        expect(tokenizeElement(mount('<p>Hello</p>\n\n<p>World</p>')).tokens).toEqual(['Hello', 'World']);
    });

    it('harvests translatable attributes', () => {
        const { tokens } = tokenizeElement(
            mount('<input placeholder="Your name"><img alt="A cat"><span title="Tooltip"></span>'),
        );

        expect(tokens).toContain('Your name');
        expect(tokens).toContain('A cat');
        expect(tokens).toContain('Tooltip');
    });

    it('harvests aria-label', () => {
        expect(tokenizeElement(mount('<button aria-label="Close dialog"></button>')).tokens)
            .toContain('Close dialog');
    });

    it('harvests button and submit-input values', () => {
        const { tokens } = tokenizeElement(
            mount('<button value="Save"></button><input type="submit" value="Send">'),
        );

        expect(tokens).toContain('Save');
        expect(tokens).toContain('Send');
    });

    it('ignores values on non-submit inputs', () => {
        expect(tokenizeElement(mount('<input type="text" value="user@example.com">')).tokens)
            .not.toContain('user@example.com');
    });

    it('skips subtrees marked translate="no"', () => {
        const { tokens } = tokenizeElement(mount('<p>Keep</p><p translate="no">Brand Name</p>'));

        expect(tokens).toEqual(['Keep']);
    });

    it('skips self-managed Phrase subtrees', () => {
        const { tokens } = tokenizeElement(mount('<p>Keep</p><span data-ls-phrase>Own phrase</span>'));

        expect(tokens).toEqual(['Keep']);
    });

    it('KNOWN DEFECT: double-counts <select> option text', () => {
        // `_tokenizeAttributes` harvests option text via querySelectorAll, and
        // then `_walkForTokens` recurses into those same options and pushes
        // their text nodes again — so every option is registered twice.
        //
        // Pinned as-is rather than fixed because tokens feed generateCustomId:
        // de-duplicating changes the custom_id of every content block that
        // contains a select, orphaning its existing translations. Fix and
        // re-key deliberately, not incidentally. This test will fail loudly
        // when that happens, which is the point.
        expect(tokenizeElement(mount('<select><option>Red</option><option>Blue</option></select>')).tokens)
            .toEqual(['Red', 'Blue', 'Red', 'Blue']); // should be ['Red', 'Blue']
    });

    it('walks nested elements', () => {
        expect(tokenizeElement(mount('<div><section><p>Deep</p></section></div>')).tokens).toEqual(['Deep']);
    });

    it('returns no tokens for an empty element', () => {
        expect(tokenizeElement(mount('')).tokens).toEqual([]);
    });
});

describe('tokenizeElement — snapshot', () => {
    it('does not mutate the live element', () => {
        const el = mount('<p class="greeting">Hello</p>');
        const before = el.innerHTML;

        tokenizeElement(el);

        expect(el.innerHTML).toBe(before);
    });

    it('returns the outerHTML of the root, not just its children', () => {
        const { content } = tokenizeElement(mount('<p>Hello</p>'));

        expect(content.startsWith('<div')).toBe(true);
        expect(content).toContain('Hello');
    });
});

describe('registerContentBlock', () => {
    const block = {
        custom_id: 'abc123',
        category: 'nav',
        content: '<div>Home</div>',
        tokens: ['Home'],
        label: 'Nav',
    };

    it('no-ops with a read key and never calls the API', async () => {
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems');

        await expect(registerContentBlock(block)).resolves.toEqual({ status: true });
        expect(post).not.toHaveBeenCalled();
    });

    it('posts the block with a write key', async () => {
        config.key_type = 'write';
        const post = vi
            .spyOn(LangsysAppAPI, 'createTranslatableItems')
            .mockResolvedValue({ status: true });

        await expect(registerContentBlock(block)).resolves.toEqual({ status: true });
        expect(post).toHaveBeenCalledWith([
            {
                type: 'content_block',
                custom_id: 'abc123',
                category: 'nav',
                content: '<div>Home</div>',
                label: 'Nav',
                phrases: [{ phrase: 'Home' }],
            },
        ]);
    });

    it('stamps the block into the cache so the next mount skips the POST', async () => {
        config.key_type = 'write';
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true });

        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
        await registerContentBlock(block);
        expect(isContentBlockKnown('nav', 'abc123')).toBe(true);
    });

    it('caches an empty category under __uncategorized__', async () => {
        config.key_type = 'write';
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true });

        await registerContentBlock({ ...block, category: '' });

        expect(isContentBlockKnown('', 'abc123')).toBe(true);
    });

    it('returns status false and does not cache when the API rejects the block', async () => {
        config.key_type = 'write';
        vi.spyOn(logger, 'error').mockImplementation(() => {});
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({
            status: false,
            errors: ['nope'],
        });

        await expect(registerContentBlock(block)).resolves.toEqual({ status: false, errors: ['nope'] });
        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
    });

    it('swallows a thrown network error rather than rejecting', async () => {
        config.key_type = 'write';
        vi.spyOn(logger, 'error').mockImplementation(() => {});
        const boom = new Error('offline');
        vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockRejectedValue(boom);

        await expect(registerContentBlock(block)).resolves.toEqual({ status: false, errors: [boom] });
        expect(isContentBlockKnown('nav', 'abc123')).toBe(false);
    });
});
