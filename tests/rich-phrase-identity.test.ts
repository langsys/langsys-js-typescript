// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { encodeRichPhrase, type RichTextNode } from '../src/identity.js';
import { encodeRichText } from '../src/richtext.js';

/**
 * The `<Phrase>` key, and the split that lets a non-DOM host produce it.
 *
 * `<Phrase>` does not key by `custom_id`: inline elements become neutral
 * `{mNo}`/`{mNc}` pairs and the whole subtree collapses to ONE string, which is
 * the catalog key. So this string is as load-bearing as a `custom_id`, and two
 * implementations of it re-key every rich phrase the moment they drift —
 * arriving as a cache miss and a re-registration, not as an error.
 *
 * `encodeRichPhrase` (in `identity.ts`, on `/pure`) is that rule, generic over
 * the host's node type. `encodeRichText` is now only a DOM node-shape mapping
 * over it, so `langsys-js-server` can render `<Phrase>` from parse5 nodes without
 * a second encoder.
 *
 * THE EXPECTATIONS BELOW ARE THE PRE-REFACTOR VALUES. Every one was measured by
 * running the old `encodeRichText` — the single-function version that walked the
 * DOM and built the string itself — over the same input, then written here as a
 * literal. That is what makes them evidence: they are independent of both the
 * old implementation and the new one, so they can catch the refactor having
 * changed a key. Asserting the new code against the new code would have proved
 * only that it agrees with itself.
 *
 * PROVENANCE, and the limit of it: these were measured under happy-dom, and the
 * JS Server lane's matching assertions are measured under parse5. Neither is
 * Chromium, and the two models demonstrably disagree — `<noscript>` parses as raw
 * text under Chromium and parse5 and as markup under happy-dom and PHP's
 * libxml2, which produced different ids for identical source until the element
 * was excluded outright.
 *
 * Audited rather than assumed: every input below is text, comments, or inline
 * elements (`p`, `br`, `span`, `a`, `b`, `i`, `u`, `em`, `strong`), and none
 * exercises a family where parse models actually differ — no raw-text element, no
 * foster-parenting context inside `table`, no implied-close construct. So the
 * happy-dom provenance is immaterial for THIS set.
 *
 * It is not immaterial in general, and this file does not cover it. That gap has
 * since been CLOSED by the JS Server lane (`8105faab`), which had a browser left
 * over from the noscript measurement: Chromium 153.0.8010.12 against parse5 over
 * the three families — raw-text (`textarea`, `title`), foster parenting
 * (non-table content inside `<table>`), implied close (`<p>` after `<p>`, bare
 * `<li>`, bare `<option>`) — 9 agree, 0 diverge, with a control proving Chromium
 * demonstrably transformed the input so the agreement is structural rather than
 * two parsers both declining to act.
 *
 * libxml2 is now measured too, by the PHP lane (`db4941a`): 3 of 7 against the JS
 * family's values. Implied close agrees; raw text and foster parenting do not,
 * because the tokenizer faithfully encodes a different tree and no canonicalization
 * rule reaches that. So every `<Phrase>` containing a stray element or loose text
 * inside a `<table>`, or markup inside a `<textarea>`/`<title>`, carries a different
 * key in a libxml2 SDK — and nothing errors.
 *
 * The audit above still holds: none of the 22 inputs contains a raw-text element, a
 * foster-parenting context or an implied-close construct, so the provenance is
 * immaterial for THEM under all three models rather than just two. The rule for
 * anything added later is that well-formed markup is portable — all seven vectors
 * agree once the source needs no repair — and the splits appear only on markup a
 * browser has to fix up.
 *
 * ONE LIMIT ON THIS FILE'S OWN HARNESS, because it bears on anything added here:
 * happy-dom builds a raw-text body containing markup the LIBXML2 way, not the
 * Chromium/parse5 way — measured, tokens `['a','b','Keep']` where the JS family
 * produces `['Keep','a <b>b</b>']`, and the block id matches langsys-php's exactly.
 * So a vector added here with a `<textarea>` or `<title>` in it would agree with
 * PHP for the WRONG REASON and could never show the split. Same class as the
 * `<noscript>` artefact: the environment's parser is part of the measurement, and
 * happy-dom is not a model of Chromium on precisely the constructs where parse
 * models differ. Found by the Reviewer.
 */

function domPhrase(html: string) {
    const host = document.createElement('div');
    host.innerHTML = html;
    return encodeRichText(host);
}

describe('the refactor did not move a single key', () => {
    // Measured on the pre-refactor encoder at 1caf7fb, 22 inputs, then pasted.
    it.each([
        ['Based on reviews', 'Based on reviews', 0],
        ['Based on <strong>12 reviews</strong>', 'Based on {m0o}12 reviews{m0c}', 1],
        ['<p>a <em> b</em></p>', '{m0o}a {m1o} b{m1c}{m0c}', 2],
        ['x <em>y </em>z', 'x {m0o}y {m0c}z', 1],
        ['A <a href="/x">B <em>C</em> D</a> E', 'A {m0o}B {m1o}C{m1c} D{m0c} E', 2],
        ['<a><b><i><u>deep</u></i></b></a>', '{m0o}{m1o}{m2o}{m3o}deep{m3c}{m2c}{m1c}{m0c}', 4],
        ['<b>one</b><i>two</i><u>three</u>', '{m0o}one{m0c}{m1o}two{m1c}{m2o}three{m2c}', 3],
        ['a<!-- note -->b', 'ab', 0],
        ['<b>a<!-- n -->b</b>', '{m0o}ab{m0c}', 1],
        ['Hello %name%, you have <b>%count%</b> left', 'Hello {name}, you have {m0o}{count}{m0c} left', 1],
        ['Hello {name} and <b>{count}</b>', 'Hello {name} and {m0o}{count}{m0c}', 1],
        ['A long\n     description <b>with\n\tmarkup</b>', 'A long description {m0o}with markup{m0c}', 1],
        ['A\u00a0long   description', 'A long description', 0],
        ['a<span></span>b', 'a{m0o}{m0c}b', 1],
        ['   \n  ', '', 0],
        ['   <b>  x  </b>   ', '{m0o} x {m0c}', 1],
        ['<strong>Only</strong>', '{m0o}Only{m0c}', 1],
        ['line<br>break', 'line{m0o}{m0c}break', 1],
        ['<span class="svelte-a1b2c3">Scoped</span> text', '{m0o}Scoped{m0c} text', 1],
        ['a\u2028b <b>c\u2029d</b>', 'a b {m0o}c d{m0c}', 1],
        ['<b>1<i>2</i>3</b><u>4</u>', '{m0o}1{m1o}2{m1c}3{m0c}{m2o}4{m2c}', 3],
        ['<a href="/p" title="T">link</a>', '{m0o}link{m0c}', 1],
    ])('%j', (html, phrase, slotCount) => {
        const r = domPhrase(html as string);
        expect(r.phrase).toBe(phrase);
        expect(r.slots).toHaveLength(slotCount as number);
    });
});

describe('a host with no DOM reaches the same key', () => {
    // The point of the split. These trees are what a parse5 adapter would build;
    // the phrase has to come out byte-identical to the DOM path's.
    it('agrees on a nested phrase', () => {
        const tree: RichTextNode<string>[] = [
            { text: 'A ' },
            {
                payload: 'a[href=/x]',
                children: [{ text: 'B ' }, { payload: 'em', children: [{ text: 'C' }] }, { text: ' D' }],
            },
            { text: ' E' },
        ];
        expect(encodeRichPhrase(tree).phrase).toBe(domPhrase('A <a href="/x">B <em>C</em> D</a> E').phrase);
    });

    it('agrees on the whitespace-at-the-edge case, which is the easy one to get wrong', () => {
        const tree: RichTextNode<string>[] = [
            { payload: 'p', children: [{ text: 'a ' }, { payload: 'em', children: [{ text: ' b' }] }] },
        ];
        expect(encodeRichPhrase(tree).phrase).toBe(domPhrase('<p>a <em> b</em></p>').phrase);
    });

    it('hands each payload back in markup-token order', () => {
        const { slots } = encodeRichPhrase<string>([
            { payload: 'OUTER', children: [{ text: '1' }, { payload: 'INNER', children: [{ text: '2' }] }] },
            { payload: 'SIBLING', children: [{ text: '3' }] },
        ]);
        // Pre-order: parent before its own children, then the next sibling.
        expect(slots).toEqual(['OUTER', 'INNER', 'SIBLING']);
    });

    it('returns an empty phrase for no nodes', () => {
        expect(encodeRichPhrase([])).toEqual({ phrase: '', slots: [] });
    });
});

describe('the three rules an adapter has to match', () => {
    it('1. slot indices are pre-order, so a nested phrase numbers parent-first', () => {
        // Reversing to post-order would give {m1o}{m0o}…: same set of tokens,
        // different string, different key, and no error anywhere.
        expect(encodeRichPhrase<string>([
            { payload: 'A', children: [{ payload: 'B', children: [{ text: 'x' }] }] },
        ]).phrase).toBe('{m0o}{m1o}x{m1c}{m0c}');
    });

    it('2. whitespace collapses ONCE over the assembled string, not per node', () => {
        // The space before `b` stays INSIDE the inner markers. A per-node trim
        // would move it outside them — `{m0o}a{m1o}b{m1c}{m0c}` — which is a
        // different key for the same authored markup. This is the same mistake
        // that split `custom_id` between the attribute path and the text path.
        const perNodeTrimWouldGive = '{m0o}a{m1o}b{m1c}{m0c}';
        const actual = encodeRichPhrase<string>([
            { payload: 'p', children: [{ text: 'a ' }, { payload: 'em', children: [{ text: ' b' }] }] },
        ]).phrase;
        expect(actual).toBe('{m0o}a {m1o} b{m1c}{m0c}');
        expect(actual).not.toBe(perNodeTrimWouldGive);
    });

    it('3. %name% normalizes, and a non-identifier percent run is left alone', () => {
        expect(encodeRichPhrase<string>([{ text: 'Hi %name%' }]).phrase).toBe('Hi {name}');
        // Prose must survive: no identifier between the percent signs.
        expect(encodeRichPhrase<string>([{ text: 'Save 20% to 30% off' }]).phrase).toBe('Save 20% to 30% off');
    });
});

describe('nodes that are neither text nor element', () => {
    // Measured, because the rule is narrower than "omit them".
    it('mapping one to empty text is harmless', () => {
        const dropped = encodeRichPhrase<string>([{ text: 'a' }, { text: 'b' }]).phrase;
        const asEmpty = encodeRichPhrase<string>([{ text: 'a' }, { text: '' }, { text: 'b' }]).phrase;
        expect(asEmpty).toBe(dropped);
        expect(asEmpty).toBe('ab');
    });

    it('but contributing its data, or a slot, changes the key', () => {
        // These are the two real adapter mistakes. The slot form is worse than it
        // looks: it also shifts every later index.
        expect(encodeRichPhrase<string>([{ text: 'a' }, { text: ' note ' }, { text: 'b' }]).phrase).toBe('a note b');
        expect(encodeRichPhrase<string>([
            { text: 'a' },
            { payload: 'COMMENT', children: [] },
            { text: 'b' },
        ]).phrase).toBe('a{m0o}{m0c}b');
        // …and the DOM adapter does neither.
        expect(domPhrase('a<!-- note -->b').phrase).toBe('ab');
    });
});

describe('the DOM adapter still returns reusable elements', () => {
    it('keeps the framework-owned element, shallow, for reconstitution', () => {
        const { slots } = domPhrase('<span class="svelte-a1b2c3" data-x="1">Scoped</span>');
        expect(slots).toHaveLength(1);
        // Scoped CSS survival is the reason slots carry the real element rather
        // than a tag name: a rebuilt <span> would lose the build-specific class.
        expect(slots[0]!.template.getAttribute('class')).toBe('svelte-a1b2c3');
        expect(slots[0]!.template.getAttribute('data-x')).toBe('1');
        // Shallow: children belong to the translated string, not the template.
        expect(slots[0]!.template.childNodes).toHaveLength(0);
    });
});
