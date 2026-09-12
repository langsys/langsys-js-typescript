// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { interpolate } from '../src/interpolate.js';
import { encodeRichPhrase, NON_TRANSLATABLE_ELEMENTS, normalizeTokenText, TRANSLATABLE_ATTRIBUTES } from '../src/identity.js';

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

    it('does not harvest <math> content — notation, not prose', () => {
        // Added by spec 8.0.1 after v8 shipped without it. Measured before the
        // exclusion: tokens were ['Area', 'x', '+', '2', 'units'] — a bare
        // variable and an OPERATOR registered as translatable phrases and sent
        // for machine translation. Translating either corrupts the expression
        // rather than localising it, which is why this is not merely wasteful the
        // way harvesting CSS was.
        expect(tokensOf('<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>')).toEqual([
            'Area',
            'units',
        ]);
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

    it('does not harvest <noscript> either, under EITHER parser model', () => {
        // TOK-1 reversed on noscript, and the reasoning is worth keeping because
        // the obvious answer was the wrong one. Its text does render to a real
        // visitor when scripting is off — true, and it does not survive asking
        // who could act on it: with scripting off a browser SDK is not running,
        // so it can translate nothing on that page including this.
        //
        // And with scripting ENABLED, which is the spec's default, a parser makes
        // the body RAW TEXT. Chromium and parse5 both produce the single token
        // '<p>Enable JavaScript</p>' — markup sent to machine translation, which
        // is this family's own failure mode arriving through the rule meant to
        // prevent it.
        //
        // Model A — scripting disabled, which is what happy-dom and PHP's
        // libxml2 give. The body parses as markup.
        expect(tokensOf('<noscript><p>Enable JavaScript</p></noscript><p>Plans</p>')).toEqual(['Plans']);
    });

    it('…and under the raw-text shape a scripting-enabled parser produces', () => {
        // Model B, constructed by hand because happy-dom cannot produce it. This
        // is the shape Chromium and parse5 actually emit; excluding the element
        // means neither model contributes a token, so the two stop disagreeing.
        const host = document.createElement('div');
        const keep = document.createElement('p');
        keep.textContent = 'Keep';
        const ns = document.createElement('noscript');
        ns.appendChild(document.createTextNode('<p>Enable JavaScript</p>'));
        host.appendChild(keep);
        host.appendChild(ns);

        expect(tokenizeElement(host).tokens).toEqual(['Keep']);

        // The point of the reversal: the two parser models now AGREE, where
        // before they produced different ids for the same source.
        expect(tokenizeElement(host).tokens).toEqual(
            tokensOf('<p>Keep</p><noscript><p>Enable JavaScript</p></noscript>')
        );
    });

    it('TOK-1\u2019s own test shape: one sentence in all four positions yields exactly one phrase', () => {
        // The published rule specifies this form, and it is stronger than the
        // per-element tests above. THE SAME SENTENCE sits inside <script>,
        // <style> and <noscript> and once in ordinary markup, in ONE document,
        // and exactly one phrase must come out — the ordinary one.
        //
        // Why that beats testing each element separately, which is what this
        // file did first: separate cases with different content pass even if the
        // walker skipped the ordinary copy and harvested a skipped one, because
        // no single case ever sees both. Identical content in one document makes
        // the count itself the assertion, so "exactly one" can only be satisfied
        // by skipping the right three and keeping the right one.
        //
        // FOUR elements as of 8.0.1, `<math>` having joined them. The shape is
        // what makes the addition safe to assert: with the same sentence in all
        // four AND once in ordinary markup, "exactly one phrase" can only be
        // satisfied by skipping the right four and keeping the right one.
        const SENTENCE = 'Enable JavaScript';
        const tokens = tokensOf(
            `<script>${SENTENCE}</script>` +
                `<style>${SENTENCE}</style>` +
                `<noscript>${SENTENCE}</noscript>` +
                `<math>${SENTENCE}</math>` +
                `<p>${SENTENCE}</p>`
        );

        expect(tokens).toEqual([SENTENCE]);
        expect(tokens).toHaveLength(1);
    });

    it('<svg> is NOT excluded: its text is harvested AND the parent keeps its own', () => {
        // 8.0.1 states this behaviourally, and the history is the reason. An
        // earlier draft said "walk <svg> as a block element"; PHP implemented
        // exactly that and it broke ordinary pages — treating svg as a block made
        // the walker drop the PARENT's direct text, so an icon in a heading, link
        // or list item cost that element its words.
        //
        // The spec's own vector, and the order is part of it: the block's tokens
        // are its own text plus the svg's text, in document order.
        expect(tokensOf('<p>Click <svg><text>go</text><path/></svg> to continue</p>')).toEqual([
            'Click',
            'go',
            'to continue',
        ]);
    });

    it('…and adding svg to the exclusion list would reproduce the regression', () => {
        // A pin on an ABSENCE, which is otherwise the kind of requirement nothing
        // tests. `NON_TRANSLATABLE_ELEMENTS` must not grow `svg`: the assertion
        // above is what fails if it does, and this states the contract directly so
        // the reason survives next to it.
        expect(NON_TRANSLATABLE_ELEMENTS).not.toContain('svg');
        expect(NON_TRANSLATABLE_ELEMENTS).toEqual(['script', 'style', 'template', 'noscript', 'math']);
    });

    it('control: ordinary markup is still tokenized — the exclusion is five tags, not a mood', () => {
        // The rule names this as the whole test. Excluding too much is the
        // failure mode on the other side of TOK-1, and it looks identical from
        // the outside: content that is simply never translated.
        expect(tokensOf('<div><p>Keep</p><span>Also keep</span></div>')).toEqual(['Keep', 'Also keep']);
        expect(tokensOf('<p>Plans</p>')).toEqual(['Plans']);
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

describe('(b2) TOK-2 at spec 5c5c0723: membership on the collapse function, and its three vectors', () => {
    /**
     * The target spec's TOK-2 adds a test consequence: where a parser has already
     * dropped a character, a DOM-level test that it is NOT collapsed passes for the
     * wrong reason, because the character never reached the collapse step. So
     * membership is asserted on `normalizeTokenText` itself, a string in and a
     * string out, with no parser in between.
     *
     * Characters are built with `String.fromCodePoint`, never typed. A literal would
     * render as a space, and an escape typed into some editors and tools arrives as
     * the character itself.
     *
     * DELIBERATELY ABSENT: the C0 controls U+0001-U+0008, U+000B, U+000C and
     * U+000E-U+001F. TOK-2's control-character handling is HELD pending the
     * operator's ruling on stripping them, and VT and FF keep today's behaviour
     * (they collapse). TAB, LF and CR are not in the held range and are asserted.
     */
    const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
    const ch = (cp: number) => String.fromCodePoint(cp);
    const NBSP = ch(0xa0);

    const MEMBERS = [0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
        0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
    const NON_MEMBERS = [0x85, 0x180e, 0x200b, 0x2060];

    it.each(MEMBERS.map((cp) => [hex(cp), cp] as const))('%s is a member: it collapses to one space', (_label, cp) => {
        expect(normalizeTokenText('a' + ch(cp) + ch(cp) + 'b')).toBe('a b');
    });

    it.each(NON_MEMBERS.map((cp) => [hex(cp), cp] as const))('%s is not a member: it survives', (_label, cp) => {
        expect(normalizeTokenText('a' + ch(cp) + 'b')).toBe('a' + ch(cp) + 'b');
    });

    it('vector 1: Buy now spaced with U+0020 and with U+00A0 yields one id', () => {
        expect(idOf('<p>Buy' + NBSP + 'now</p>')).toBe(idOf('<p>Buy now</p>'));
    });

    it('vector 2: the same character LEADING and TRAILING, not only internal', () => {
        // A fix applied to the collapse alone can pass vector 1 and still keep a
        // leading or trailing one, so vector 1 cannot tell a finished
        // implementation from a half-finished one.
        expect(tokensOf('<p>' + NBSP + 'Buy now' + NBSP + '</p>')).toEqual(['Buy now']);
        expect(idOf('<p>' + NBSP + 'Buy now' + NBSP + '</p>')).toBe(idOf('<p>Buy now</p>'));
    });

    it('vector 3: a whitespace-only node produces NO token, which is what moves block ids', () => {
        // A token COUNT, not a value: one token where U+00A0 survives, zero where it
        // collapses away, so the disagreement re-keys every block containing one.
        expect(tokensOf('<p>' + NBSP + '</p>')).toEqual([]);
        expect(tokensOf('<div><p>Keep</p><p>' + NBSP + '</p></div>')).toEqual(['Keep']);
    });

    it('control: a pair differing by a character that genuinely changes the text yields two ids', () => {
        expect(idOf('<p>Buy now</p>')).not.toBe(idOf('<p>Buy nov</p>'));
    });

    it('every path: the <Phrase> key collapses through the same function', () => {
        // CONF-1's every-path clause, reached from TOK-2. The content-block path is
        // asserted above; attribute registration and Translate's lookup side are
        // asserted in `translate` ("register and lookup agree on every path"); this
        // is the Phrase path.
        expect(encodeRichPhrase([{ text: NBSP + 'Buy' + NBSP + NBSP + 'now' + NBSP }]).phrase).toBe('Buy now');
    });
});
