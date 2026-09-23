// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { encodeRichPhrase, normalizeTokenText, stripC0Controls } from '../src/identity.js';
import { createSignal } from '../src/signal.js';
import { sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * TOK-2's strip clause: the 28 C0 controls — U+0001–U+0008, U+000B, U+000C, U+000E–U+001F — are
 * removed before anything collapses, from every string that becomes an id input or a catalog key,
 * on register and on lookup alike. Strip, then collapse, then trim.
 *
 * Asserted on the canonicalization function itself, a string in and a string out, as the rule's
 * Test clause asks: a DOM-level test can pass for the wrong reason where a parser has already
 * dropped the character. Then on each path the rule names. Every character is built from its code
 * point, never typed.
 */

const ch = (cp: number) => String.fromCodePoint(cp);
const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const STRIPPED = [
    ...Array.from({ length: 8 }, (_, i) => 0x01 + i),
    0x0b,
    0x0c,
    ...Array.from({ length: 18 }, (_, i) => 0x0e + i),
];
const tokensOf = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return tokenizeElement(host).tokens;
};
const idOf = (html: string) => generateCustomId('UI', tokensOf(html));

describe('the strip set, on the canonicalization function', () => {
    it('is exactly 28 characters', () => {
        expect(STRIPPED).toHaveLength(28);
    });

    it.each(STRIPPED.map((cp) => [hex(cp), cp] as const))('%s is removed, not turned into a space', (_label, cp) => {
        expect(normalizeTokenText('a' + ch(cp) + 'b')).toBe('ab');
        expect(stripC0Controls('a' + ch(cp) + 'b')).toBe('ab');
    });

    it.each([0x09, 0x0a, 0x0d].map((cp) => [hex(cp), cp] as const))('%s is not stripped: it collapses to one space', (_label, cp) => {
        expect(normalizeTokenText('a' + ch(cp) + 'b')).toBe('a b');
    });

    it.each([0x00, 0x7f, 0x80, 0x85, 0x9f].map((cp) => [hex(cp), cp] as const))('%s is kept', (_label, cp) => {
        expect(normalizeTokenText('a' + ch(cp) + 'b')).toBe('a' + ch(cp) + 'b');
    });

    it('strips before it collapses: VT is removed, so it never becomes a space', () => {
        // Collapse first would turn VT into a space, since VT is in JavaScript's \s.
        expect(normalizeTokenText('a' + ch(0x0b) + 'b')).toBe('ab');
        expect(normalizeTokenText('a ' + ch(0x0b) + ' b')).toBe('a b');
    });

    it('and trims last: a string of only stripped characters and spaces is empty', () => {
        expect(normalizeTokenText(' ' + ch(0x1c) + ' ' + ch(0x0c) + ' ')).toBe('');
    });
});

describe('every path the rule names', () => {
    const ALONG = 'A' + ch(0x1c) + 'long';

    it('a text node', () => {
        expect(tokensOf('<p>' + ALONG + '</p>')).toEqual(['Along']);
    });

    it('a translatable attribute, which every parser keeps the character in, so the SDK must strip it', () => {
        const host = document.createElement('div');
        const img = document.createElement('img');
        img.setAttribute('alt', ALONG);
        host.appendChild(img);
        expect(tokenizeElement(host).tokens).toEqual(['Along']);
    });

    it('the text of a <Phrase> key', () => {
        expect(encodeRichPhrase([{ text: ALONG }]).phrase).toBe('Along');
    });

    describe('a t() key, on lookup and on registration', () => {
        let tr: Translations;
        const t = () => tr.tSignal.get() as unknown as (p: string, c: string) => string;
        beforeEach(() => {
            const g = globalThis as unknown as Record<string, unknown>;
            g.window ??= { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
            vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true } as never);
            for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
                vi.spyOn(console, m).mockImplementation(() => {});
            }
            tr = new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('es-es'), baseLocale: 'en' });
        });
        afterEach(() => {
            tr.destroy();
            vi.restoreAllMocks();
            writeEnabled.set(undefined);
        });

        it('a key carrying a control character finds the catalog entry stored without it', () => {
            sTranslations.set({ UI: { __category__: 'UI', __symbol__: 'UI', Along: 'A lo largo' } } as never);
            expect(t()(ALONG, 'UI')).toBe('A lo largo');
            expect(tr.lookup(ALONG, 'UI')).toBe('A lo largo');
        });

        it('a miss registers the stripped key, and renders the phrase as written', () => {
            writeEnabled.set(true);
            sTranslations.set({ UI: { __category__: 'UI', __symbol__: 'UI' } } as never);
            expect(t()(ALONG, 'UI')).toBe(ALONG);
            const queued = (tr as unknown as { missingTokens: Array<{ token: string }> }).missingTokens.map((m) => m.token);
            expect(queued).toEqual(['Along']);
        });
    });
});

describe("the ids the spec's rows specify, on the carrier <p>A[cp]long   description</p>", () => {
    const carrier = (cp: number) => '<p>A' + ch(cp) + 'long   description</p>';

    it('U+001C and U+000B each give the id of the carrier with the character removed', () => {
        const removed = idOf('<p>Along   description</p>');
        expect(idOf(carrier(0x1c))).toBe(removed);
        expect(idOf(carrier(0x0b))).toBe(removed);
    });

    it('U+0009 still collapses: it gives the plain-space id', () => {
        expect(idOf(carrier(0x09))).toBe(idOf('<p>A long   description</p>'));
    });

    it('U+007F and U+0085 are kept: each gives a distinct id', () => {
        const ids = new Set([idOf(carrier(0x7f)), idOf(carrier(0x85)), idOf('<p>Along   description</p>'), idOf('<p>A long   description</p>')]);
        expect(ids.size).toBe(4);
    });
});
