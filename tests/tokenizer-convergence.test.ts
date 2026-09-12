// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { interpolate } from '../src/interpolate.js';
import { normalizeTokenText, TRANSLATABLE_ATTRIBUTES } from '../src/identity.js';

/**
 * TOKENIZER CONVERGENCE with langsys-php — the identity contract.
 *
 * These change `custom_id` for affected blocks, which re-register under the new
 * id and show source text until re-translated. That cost was accepted
 * deliberately; legacy-id tolerance was considered and declined, so there is no
 * migration path and none is implied here.
 *
 * Each case below was MEASURED on the pre-convergence tokenizer, and the old
 * value is recorded beside it — the point of these tests is not that the new
 * output looks right, it is that it differs from a known prior value in a stated
 * way.
 */

function tokensOf(html: string): string[] {
    const host = document.createElement('div');
    host.innerHTML = html;
    return tokenizeElement(host).tokens;
}

const idOf = (html: string) => generateCustomId('', tokensOf(html));

describe('(a) code-bearing subtrees are not prose', () => {
    it('does not harvest <style> content', () => {
        // Measured before: tokens were ['.plan{color:#fff}', 'Plans'], id
        // b67f733af1… — the CSS was registered as a translatable phrase and
        // sent for machine translation.
        expect(tokensOf('<style>.plan{color:#fff}</style><p>Plans</p>')).toEqual(['Plans']);
    });

    it('does not harvest <script> content', () => {
        // Measured before: ['window.dataLayer.push(1)', 'Plans'], id 7cd0a69f33…
        expect(tokensOf('<script>window.dataLayer.push(1)</script><p>Plans</p>')).toEqual(['Plans']);
    });

    it('does not harvest <template> content — but this assertion does NOT discriminate', () => {
        // Honest label. Removing 'template' from the skip list leaves this green,
        // while removing script or style reds three tests. Template content is
        // not in `childNodes` at all: a DOM puts it on
        // `HTMLTemplateElement.content` as a separate DocumentFragment, so the
        // walker never reaches it and the skip is a no-op.
        //
        // Kept as a pin of that no-op, not as evidence the skip works. The JS
        // Server lane measured the same thing independently in parse5, which
        // models it identically — so adding `template` to the list expecting an
        // id to change would be a mistake in either host.
        expect(tokensOf('<template><p>hidden</p></template><p>Plans</p>')).toEqual(['Plans']);
    });

    it('DOES harvest <noscript> — under a scripting-DISABLED parser', () => {
        // True, and narrower than it reads. happy-dom has no scripting flag and
        // so takes the scripting-disabled branch, parsing the noscript body as
        // markup. A server-side parser (PHP's) does the same. This assertion
        // covers that model only.
        expect(tokensOf('<noscript><p>Enable JavaScript</p></noscript><p>Plans</p>')).toEqual([
            'Enable JavaScript',
            'Plans',
        ]);
    });

    it('but a scripting-ENABLED parser yields the literal markup, and the id diverges', () => {
        // The HTML Standard says a noscript body is RAW TEXT when scripting is
        // enabled, so a real browser produces ONE text node holding the literal
        // markup. happy-dom cannot produce that shape, so it is constructed by
        // hand — this asserts what OUR tokenizer does given that input, which is
        // the half this repo owns. It is not a measurement of a browser.
        //
        // The consequence is not a cosmetic mechanism difference: the token is
        // the markup string, so the SAME source HTML yields a DIFFERENT
        // custom_id depending on where it was tokenized. A content block
        // containing <noscript> therefore has one id on the server and another
        // in the browser, which breaks the SSR hand-off for that block — and it
        // registers markup as a translatable phrase, which is what TOK-1 exists
        // to prevent.
        //
        // Reported to Langsys as a spec question rather than patched here: any
        // fix belongs in the rule, and guessing at one would encode a guess as
        // conformance. Pinned so the divergence is visible and measured.
        const host = document.createElement('div');
        const keep = document.createElement('p');
        keep.textContent = 'Keep';
        const ns = document.createElement('noscript');
        ns.appendChild(document.createTextNode('<p>Enable JavaScript</p>'));
        host.appendChild(keep);
        host.appendChild(ns);

        expect(tokenizeElement(host).tokens).toEqual(['Keep', '<p>Enable JavaScript</p>']);

        // Stated as the divergence it is, not as an incidental difference.
        expect(tokenizeElement(host).tokens).not.toEqual(tokensOf('<p>Keep</p><noscript><p>Enable JavaScript</p></noscript>'));
    });

    it('skipping changes the id, which is the accepted cost', () => {
        expect(idOf('<style>.plan{color:#fff}</style><p>Plans</p>')).toBe(idOf('<p>Plans</p>'));
    });
});

describe('(b) U+00A0 collapses like any other whitespace', () => {
    it('already held — JavaScript \\s covers NBSP', () => {
        // Recorded rather than implemented: `\s` matches U+00A0 in JS, so the
        // existing collapse already handled it. Pinned so a future hand-rolled
        // character class cannot quietly drop it.
        //
        // Written as the ESCAPE `\u00a0`, never the character. A literal
        // non-breaking space renders identically to the plain spaces beside it,
        // so a reviewer cannot see what this test is about, and anyone tidying
        // the whitespace turns it into an assertion about ordinary spaces that
        // still passes. Same reason `interpolate.ts` writes its NUL separator as
        // an escape. Mutation-checked: narrowing `\s` to `[ \t\n\r]` reds this.
        expect(normalizeTokenText('A\u00a0long   description')).toBe('A long description');
        expect(idOf('<p>A\u00a0long   description</p>')).toBe(idOf('<p>A long description</p>'));
    });
});

describe('(c) the attribute list is PHP’s 27, in PHP’s order', () => {
    it('harvests the twelve newly added attributes', () => {
        expect(tokensOf('<button data-confirm="Are you sure?">Go</button>')).toEqual(['Are you sure?', 'Go']);
        expect(tokensOf('<span data-bs-title="Tip">x</span>')).toEqual(['Tip', 'x']);
    });

    it('keeps the original fifteen unchanged and first', () => {
        // Order is identity. Appending was safe; inserting would have re-keyed
        // every block using one of the original fifteen.
        expect(TRANSLATABLE_ATTRIBUTES.slice(0, 15)).toEqual([
            'placeholder',
            'alt',
            'title',
            'label',
            'aria-label',
            'aria-placeholder',
            'aria-description',
            'aria-valuetext',
            'aria-roledescription',
            'data-error',
            'data-error-message',
            'data-validation-message',
            'data-invalid-message',
            'data-required-message',
            'data-pattern-message',
        ]);
    });

    it('emits attributes in list order, not document order', () => {
        // Two attributes on one element, authored in the reverse of list order.
        expect(tokensOf('<img data-tooltip="Tip" alt="Alt">')).toEqual(['Alt', 'Tip']);
    });
});

describe('(d) an attribute and a text node normalise identically', () => {
    it('the same authored content yields the same token either way', () => {
        // Measured before: the attribute kept "A long\n     description"
        // (id 67a902ad01…) while the text node collapsed to "A long
        // description" (id 4ccbaabb0b…) — the same sentence, two ids.
        const multiline = 'A long\n     description';
        expect(tokensOf(`<img alt="${multiline}">`)).toEqual(['A long description']);
        expect(tokensOf(`<p>${multiline}</p>`)).toEqual(['A long description']);
    });

    it('so the ids agree, which is the property that was broken', () => {
        expect(idOf('<img alt="A long\n     description">')).toBe(idOf('<p>A long description</p>'));
    });

    it('and a <button value> collapses too, not just the listed attributes', () => {
        expect(tokensOf('<button value="Send\n  it">x</button>')).toEqual(['Send it', 'x']);
    });
});

describe('(e) %name% resolves at render, not only at capture', () => {
    it('resolves a percent placeholder', () => {
        // Measured before: 'Hi %name%' — the percent signs reached the reader.
        expect(interpolate('Hi %name%', { name: 'Ada' }, 'en')).toBe('Hi Ada');
    });

    it('resolves it inside an ICU branch too', () => {
        expect(interpolate('{n, plural, one {# for %who%} other {# for %who%}}', { n: 1, who: 'Ada' }, 'en')).toBe(
            '1 for Ada'
        );
    });

    it('leaves an UNSUPPLIED %word% alone, so prose is not mangled', () => {
        // Conversion is conditional on the key being supplied. A blanket rewrite
        // would turn any %word% into a {…} that then renders as a literal brace
        // expression — worse than the bug being fixed.
        expect(interpolate('Save 20% %off%', { x: 1 }, 'en')).toBe('Save 20% %off%');
        expect(interpolate('50% to 70% off', {}, 'en')).toBe('50% to 70% off');
    });
});
