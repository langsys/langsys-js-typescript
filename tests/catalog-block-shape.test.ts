// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId, isContentBlockKnown, tokenizeElement } from '../src/content-block.js';
import { LangsysApp } from '../src/langsys-app.js';
import { currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';
import type { iCategories } from '../src/types/translations.js';

/**
 * CAT-3: a content block that is registered but not yet translated comes back as an
 * object keyed by its custom id whose inner phrases are null, never as a null. Object
 * presence means known.
 *
 * Why it is worth a test of its own: getting it wrong causes a WRITE storm, not a read
 * one. During the machine-translation window every phrase is still null, and a check
 * that wanted a translated value would treat the block as unknown and have every
 * write-enabled visitor re-POST it until translation lands.
 */

const bare = (): iCategories =>
    ({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } }) as iCategories;
function seedUI(id: string, value: unknown) {
    sTranslations.set({ ...bare(), UI: { __category__: 'UI', __symbol__: 'UI', [id]: value } } as unknown as iCategories);
}
const tokensOf = (html: string) => {
    const h = document.createElement('div');
    h.innerHTML = html;
    return tokenizeElement(h).tokens;
};
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
    sTranslations.set(bare());
    currentlyLoadedLocale.set('en-us');
    LangsysApp.Translations.settle();
});
afterEach(() => {
    vi.restoreAllMocks();
    writeEnabled.set(undefined);
});

describe('CAT-3: a registered content block is an object, not a null', () => {
    it('counts a block whose phrases are all null as known', () => {
        seedUI('b1', { 'Phrase A': null, 'Phrase B': null });
        expect(isContentBlockKnown('UI', 'b1')).toBe(true);
    });

    it('does not count a null or a string under the id as a block', () => {
        seedUI('b2', null);
        expect(isContentBlockKnown('UI', 'b2')).toBe(false);
        seedUI('b3', 'Phrase A');
        expect(isContentBlockKnown('UI', 'b3')).toBe(false);
    });

    it('a write-enabled session does not re-register a block that is known but untranslated', async () => {
        writeEnabled.set(true);
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true } as never);
        const html = '<p>Phrase A</p><p>Phrase B</p>';
        const tokens = tokensOf(html);
        seedUI(generateCustomId('UI', tokens), Object.fromEntries(tokens.map((t) => [t, null])));

        const host = document.createElement('div');
        host.innerHTML = html;
        const t = new Translate(host, { category: 'UI' });
        await settle();
        expect(post).not.toHaveBeenCalled();
        t.destroy();
    });

    it('control: the same session DOES register a block the catalog does not have', async () => {
        writeEnabled.set(true);
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true } as never);
        const host = document.createElement('div');
        host.innerHTML = '<p>Phrase A</p><p>Phrase B</p>';
        const t = new Translate(host, { category: 'UI' });
        await settle();
        expect(post).toHaveBeenCalledTimes(1);
        t.destroy();
    });
});
