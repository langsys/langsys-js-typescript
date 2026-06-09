// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
    encodeRichText,
    markupTokenValues,
    reconstitute,
    stripSentinels,
} from '../src/richtext.js';
import { interpolate } from '../src/interpolate.js';
import { tokenizeElement } from '../src/content-block.js';

function hostWith(html: string): HTMLElement {
    const el = document.createElement('span');
    el.innerHTML = html;
    return el;
}

/** Resolve a stored translation the way the Phrase handler does, then rebuild DOM. */
function render(raw: string, slots: ReturnType<typeof encodeRichText>['slots'], params: Record<string, unknown> = {}, locale = 'en') {
    const resolved = interpolate(raw, { ...params, ...markupTokenValues(slots.length) }, locale);
    const container = document.createElement('div');
    container.replaceChildren(...reconstitute(resolved, slots, document));
    return container;
}

describe('encodeRichText', () => {
    it('replaces an inline element with a markup-token pair', () => {
        const { phrase, slots } = encodeRichText(hostWith('You have {n} <strong>reviews</strong>'));
        expect(phrase).toBe('You have {n} {m0o}reviews{m0c}');
        expect(slots).toHaveLength(1);
        expect(slots[0].template.tagName.toLowerCase()).toBe('strong');
    });

    it('never sends framework/scoped classes — but captures them on the slot', () => {
        const { phrase, slots } = encodeRichText(hostWith('<span class="svelte-a1b2c3">White</span> House'));
        // The wire form is class-free and build-stable.
        expect(phrase).toBe('{m0o}White{m0c} House');
        expect(phrase).not.toContain('svelte');
        // The real class is preserved on the captured slot for reconstitution.
        expect(slots[0].template.getAttribute('class')).toBe('svelte-a1b2c3');
    });

    it('preserves nesting with paired tokens', () => {
        const { phrase, slots } = encodeRichText(hostWith('<strong><em>x</em></strong>'));
        expect(phrase).toBe('{m0o}{m1o}x{m1c}{m0c}');
        expect(slots.map((s) => s.template.tagName.toLowerCase())).toEqual(['strong', 'em']);
    });
});

describe('reconstitute — round trip', () => {
    it('rebuilds the original structure when nothing reorders', () => {
        const { phrase, slots } = encodeRichText(hostWith('You have <strong>news</strong>'));
        const container = render(phrase, slots);
        expect(container.innerHTML).toBe('You have <strong>news</strong>');
    });

    it('reuses the captured element so attributes survive', () => {
        const { phrase, slots } = encodeRichText(hostWith('See <a href="/x" class="link">docs</a>'));
        const container = render(phrase, slots);
        const a = container.querySelector('a');
        expect(a?.getAttribute('href')).toBe('/x');
        expect(a?.getAttribute('class')).toBe('link');
        expect(a?.textContent).toBe('docs');
    });
});

describe('the <span class="white">White</span> House scenario', () => {
    it('lets markup follow meaning across reordering, with the class preserved', () => {
        // Source: the emphasis is on the COLOR word "White".
        const { phrase, slots } = encodeRichText(hostWith('<span class="white">White</span> House'));
        expect(phrase).toBe('{m0o}White{m0c} House');

        // What langsys-ai would store for es-es: the words reorder (House->Casa
        // first) and the model moves the markup tokens to wrap the color word.
        const storedEs = 'Casa {m0o}Blanca{m0c}';

        const container = render(storedEs, slots, {}, 'es-es');

        // Emphasis landed on "Blanca" (the color), not "Casa" — and the class survived.
        expect(container.textContent).toBe('Casa Blanca');
        const span = container.querySelector('span.white');
        expect(span).not.toBeNull();
        expect(span?.textContent).toBe('Blanca');
        // "Casa " is plain text before the span.
        expect(container.firstChild?.nodeType).toBe(Node.TEXT_NODE);
        expect(container.firstChild?.textContent).toBe('Casa ');
    });
});

describe('reconstitute — ICU plural with markup', () => {
    const { slots } = encodeRichText(hostWith('You have {n} <strong>reviews</strong>'));
    // What langsys-ai would store: ICU plural with the markup tokens preserved inside each branch.
    const storedIcu =
        '{n, plural, one {You have # {m0o}review{m0c}} other {You have # {m0o}reviews{m0c}}}';

    it('renders the singular branch with the element wrapping the singular noun', () => {
        const container = render(storedIcu, slots, { n: 1 });
        expect(container.textContent).toBe('You have 1 review');
        expect(container.querySelector('strong')?.textContent).toBe('review');
    });

    it('renders the plural branch', () => {
        const container = render(storedIcu, slots, { n: 5 });
        expect(container.textContent).toBe('You have 5 reviews');
        expect(container.querySelector('strong')?.textContent).toBe('reviews');
    });
});

describe('reconstitute — graceful degradation', () => {
    it('falls back to plain text when sentinels are unbalanced', () => {
        const { slots } = encodeRichText(hostWith('a <strong>b</strong>'));
        // Simulate the model dropping the close token — open with no close.
        const broken = 'a ' + markupTokenValues(slots.length).m0o + 'b';
        const container = document.createElement('div');
        container.replaceChildren(...reconstitute(broken, slots, document));
        // No <strong>, no stray sentinel chars — just the text.
        expect(container.querySelector('strong')).toBeNull();
        expect(container.textContent).toBe(stripSentinels(broken));
        expect(container.textContent).toBe('a b');
    });
});

describe('Translate tokenizer skips marked subtrees', () => {
    it('does not tokenize a data-ls-phrase subtree', () => {
        const host = document.createElement('div');
        host.innerHTML =
            'We have <strong>upgraded</strong> your account ' +
            '<span data-ls-phrase>{n} <strong>reviews</strong></span>';
        const { tokens } = tokenizeElement(host);
        expect(tokens).toContain('We have');
        expect(tokens).toContain('upgraded');
        expect(tokens).toContain('your account');
        expect(tokens).not.toContain('reviews');
        expect(tokens.join(' ')).not.toContain('{n}');
    });

    it('does not tokenize a translate="no" subtree (DontTranslate)', () => {
        const host = document.createElement('div');
        host.innerHTML = 'Built with <span translate="no">Kangen</span> today';
        const { tokens } = tokenizeElement(host);
        expect(tokens).toContain('Built with');
        expect(tokens).toContain('today');
        expect(tokens).not.toContain('Kangen');
    });
});
