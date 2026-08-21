// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { generateCustomId, tokenizeElement, TRANSLATABLE_ATTRIBUTES } from '../src/content-block.js';
import { encodeRichText } from '../src/richtext.js';

/**
 * These tests pin `custom_id` IDENTITY, not rendered output.
 *
 * `custom_id` is a wire value shared by every Langsys SDK — the TS base, the
 * React/Vue/Svelte bindings, `langsys-php`, and `langsys-js-server`. If the
 * token array changes shape, the same markup registers under two ids in
 * different SDKs and the catalog silently fragments: translators see
 * duplicates, half the app resolves, half falls back to base language, and
 * nothing errors.
 *
 * Every assertion here fails on a change that an output-level test would wave
 * through, which is the whole point. Do not "fix" a failure by updating the
 * pinned literal — a changed literal IS the breaking change, and it needs a
 * migration path (see `generateLegacyCustomId`) rather than a new expectation.
 */

const span = (build: (el: HTMLElement) => void): HTMLElement => {
    const el = document.createElement('span');
    build(el);
    return el;
};

describe('custom_id identity: text-node arity', () => {
    // The contract: ONE TOKEN PER TEXT NODE. `generateCustomId` hashes
    // JSON.stringify([category, tokens]), so the ARITY of the array is
    // load-bearing, not merely its concatenated content.
    //
    // This matters because "coalesce adjacent text nodes before tokenizing"
    // is a tidy-looking cleanup that reviews well and re-keys every catalog
    // in existence. Frameworks routinely split a single authored sentence
    // across several text nodes — React renders `Hello {name}!` as three.

    it('emits one token per text node, and does NOT coalesce adjacent ones', () => {
        const el = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createTextNode('Bob'));
            e.appendChild(document.createTextNode('!'));
        });
        const { tokens } = tokenizeElement(el);
        expect(tokens).toEqual(['Hello', 'Bob', '!']);
        expect(tokens).toHaveLength(3);
    });

    it('gives a merged text node a DIFFERENT id than the same characters split', () => {
        const split = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createTextNode('Bob'));
            e.appendChild(document.createTextNode('!'));
        });
        const merged = span((e) => e.appendChild(document.createTextNode('Hello Bob!')));

        const splitId = generateCustomId('T', tokenizeElement(split).tokens);
        const mergedId = generateCustomId('T', tokenizeElement(merged).tokens);

        // If these ever compare equal, arity has stopped being identity-bearing
        // and every previously-registered split block has re-keyed.
        expect(splitId).not.toBe(mergedId);
        expect(splitId).toBe('54a3cc7ec60d532a52a726c1fad6d63d');
        expect(mergedId).toBe('0298b3fd9f88fe0c5a21e2f102813c27');
    });
});

describe('custom_id identity: comment nodes', () => {
    // React emits `<!-- -->` separators between adjacent text children, and
    // they SURVIVE hydration — they are present in the live DOM the walker
    // sees. The walker skips them structurally (a comment is neither
    // TEXT_NODE nor ELEMENT_NODE) while leaving the text on either side as
    // separate nodes, which is exactly the required behaviour.
    //
    // Stripping comments TEXTUALLY (a regex over HTML) instead of skipping
    // them during a node walk would merge the surrounding text runs and
    // change the id. Parse, never regex.

    it('skips a comment without merging the text runs either side', () => {
        const el = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createComment(' '));
            e.appendChild(document.createTextNode('Bob'));
        });
        const { tokens } = tokenizeElement(el);
        expect(tokens).toEqual(['Hello', 'Bob']);
        expect(tokens).toHaveLength(2);
    });

    it('matches the un-separated split form, so hydration does not re-key', () => {
        const withComment = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createComment(' '));
            e.appendChild(document.createTextNode('Bob'));
        });
        const withoutComment = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createTextNode('Bob'));
        });
        expect(generateCustomId('T', tokenizeElement(withComment).tokens)).toBe(
            generateCustomId('T', tokenizeElement(withoutComment).tokens),
        );
    });
});

describe('custom_id identity: attribute emission order', () => {
    // Attributes are harvested by iterating the TRANSLATABLE_ATTRIBUTES
    // constant BY NAME — never by enumerating `element.attributes`. That is
    // what makes source attribute order irrelevant to the id, and it is the
    // property `langsys-php` also has. Switching to an element-order walk
    // would make `<img title alt>` and `<img alt title>` different blocks.

    it('is unaffected by the order attributes appear in the source', () => {
        const a = span((e) => (e.innerHTML = '<img title="T" alt="A">'));
        const b = span((e) => (e.innerHTML = '<img alt="A" title="T">'));
        expect(tokenizeElement(a).tokens).toEqual(tokenizeElement(b).tokens);
    });

    it('emits attributes in constant order, before the element\'s own children', () => {
        const el = span((e) => (e.innerHTML = '<img alt="Alt text" title="Title text"><b>child</b>'));
        const { tokens } = tokenizeElement(el);
        // 'title' precedes 'alt' in the source above but not in the constant.
        expect(TRANSLATABLE_ATTRIBUTES.indexOf('alt')).toBeLessThan(TRANSLATABLE_ATTRIBUTES.indexOf('title'));
        expect(tokens).toEqual(['Alt text', 'Title text', 'child']);
    });

    // POSITIVE CONTROL for the two exclusion tests below. They assert an
    // ABSENCE, and an absence assertion passes trivially if the thing was
    // never present: "exclusion drops alt" and "alt is never harvested at all"
    // are indistinguishable without this. It also fails loudly if `alt` ever
    // leaves TRANSLATABLE_ATTRIBUTES, which would otherwise silently hollow
    // out both tests while leaving them green.
    it('harvests alt in the first place (control for the exclusion tests)', () => {
        const el = span((e) => (e.innerHTML = '<img alt="ALTTEXT">'));
        expect(tokenizeElement(el).tokens).toEqual(['ALTTEXT']);
    });

    it('drops attributes of an excluded subtree along with its text', () => {
        // The exclusion check returns BEFORE attribute harvesting, so
        // translate="no" on an element removes its alt as well as its children.
        const el = span((e) => (e.innerHTML = '<p>Keep <img translate="no" alt="ALTTEXT"> end</p>'));
        expect(tokenizeElement(el).tokens).toEqual(['Keep', 'end']);
    });

    it('drops them when the exclusion is on an ancestor, not the element', () => {
        const el = span(
            (e) => (e.innerHTML = '<p>Keep <span translate="no"><img alt="ALTTEXT"></span> end</p>'),
        );
        expect(tokenizeElement(el).tokens).toEqual(['Keep', 'end']);
    });
});

describe('Phrase path: coalescing is REQUIRED here, not forbidden', () => {
    // The mirror image of everything above. `encodeRichText` feeds a plain
    // phrase lookup — no token array, no custom_id — so adjacent text nodes
    // MUST concatenate into one string. Every other test in this file guards
    // against coalescing being added; these guard against it being removed by
    // someone who read the `_walkForTokens` contract and applied it here.

    it('concatenates adjacent text nodes into a single phrase', () => {
        const el = span((e) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createTextNode('Bob'));
            e.appendChild(document.createTextNode('!'));
        });
        expect(encodeRichText(el).phrase).toBe('Hello Bob!');
    });

    it('keeps a markup-bearing sentence whole across a split text run', () => {
        const el = span((e) => {
            e.appendChild(document.createTextNode('Based on '));
            e.appendChild(document.createTextNode('42'));
            const strong = document.createElement('strong');
            strong.appendChild(document.createTextNode('reviews'));
            e.appendChild(strong);
        });
        // One entry, so a translator can inflect the noun for the count.
        expect(encodeRichText(el).phrase).toBe('Based on 42{m0o}reviews{m0c}');
    });

    it('is the OPPOSITE of the content-block path on identical DOM', () => {
        const build = (e: HTMLElement) => {
            e.appendChild(document.createTextNode('Hello '));
            e.appendChild(document.createTextNode('world'));
        };
        expect(tokenizeElement(span(build)).tokens).toEqual(['Hello', 'world']);
        expect(encodeRichText(span(build)).phrase).toBe('Hello world');
    });
});
