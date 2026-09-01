import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from '../src/signal.js';
import { sTranslations, writeEnabled } from '../src/stores.js';
import { Translations } from '../src/translations.js';

/**
 * REG-11 — warn on ellipsis-terminated text, and register it anyway.
 *
 * Upstream truncation puts the ellipsis in the string, so the truncated form is
 * translated and stored and never matches the full paragraph, which later
 * registers as a second phrase. But a blanket skip has real false positives —
 * "Loading…" is a legitimate phrase — and silently refusing to register those
 * would be a NEW silent failure, which is the class this surface exists to
 * remove. So: warn, never skip.
 */

/** Registration only queues in a browser — under SSR it correctly declines. */
function installBrowserShim() {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = { addEventListener: () => {}, location: { href: 'https://site.local/p' } };
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
    g.sessionStorage = { getItem: () => null, setItem: () => {} };
}

function removeBrowserShim() {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
}

function newTranslations() {
    // Debug on: REG-11 is a DEBUG warning per the rule text, so production is
    // silent by design and the level is part of the contract.
    return new Translations({ projectid: 'p', key: 'k', sUserLocale: createSignal('en-us'), baseLocale: 'en', debug: true });
}

const queueOf = (t: Translations) => (t as unknown as { missingTokens: unknown[] }).missingTokens;

let warn: ReturnType<typeof vi.spyOn>;
const said = () => warn.mock.calls.flat().map(String).join(' ');

beforeEach(() => {
    installBrowserShim();
    sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } });
    writeEnabled.set(true);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    removeBrowserShim();
});

describe('ellipsis-terminated phrases', () => {
    it('warns on the unicode ellipsis, naming the phrase', () => {
        newTranslations().t('The quick brown fox jumped over…', 'UI');
        expect(said()).toContain('ellipsis');
        expect(said()).toContain('The quick brown fox jumped over…');
    });

    it('warns on three dots too', () => {
        newTranslations().t('The quick brown fox jumped over...', 'UI');
        expect(said()).toContain('ellipsis');
    });

    it('REGISTERS it anyway — skipping would be a new silent failure', () => {
        const tr = newTranslations();
        tr.t('Loading…', 'UI');
        expect(queueOf(tr)).toHaveLength(1);
    });

    it('says nothing for ordinary text', () => {
        newTranslations().t('The quick brown fox', 'UI');
        expect(said()).not.toContain('ellipsis');
    });

    it('says nothing for an ellipsis in the MIDDLE, which is not truncation', () => {
        newTranslations().t('Wait… what?', 'UI');
        expect(said()).not.toContain('ellipsis');
    });

    it('warns ONCE per phrase, not once per miss', () => {
        // On a read-only session the phrase never becomes known, so an
        // undeduped warning fires on every render for the life of the page. A
        // diagnostic that spams is a diagnostic people turn off.
        const tr = newTranslations();
        tr.t('Loading…', 'UI');
        tr.t('Loading…', 'UI');
        tr.t('Loading…', 'UI');

        expect(warn.mock.calls.filter((c) => c.map(String).join(' ').includes('ellipsis'))).toHaveLength(1);
    });

    it('is silent in production, because the rule says DEBUG warning', () => {
        const quiet = new Translations({
            projectid: 'p',
            key: 'k',
            sUserLocale: createSignal('en-us'),
            baseLocale: 'en',
        });
        quiet.t('Truncated paragraph…', 'UI');

        expect(said()).not.toContain('ellipsis');
    });
});
