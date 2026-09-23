// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { createSignal } from '../src/signal.js';
import {
    autoDiscovery,
    config as configStore,
    currentlyLoadedLocale,
    discoveryBaseLocaleOnly,
    sTranslations,
    writeEnabled,
} from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * HINT-13 in the core: `notifyNavigation()` re-enters every translated node still attached to
 * the document, as a re-render would, so its misses are recorded at the page's new URL.
 *
 * The contract-tier half — a persistent layout bound to `t`, graded against the double — is in
 * `contract-hint-lane`. This file covers the core's own DOM classes, which subscribe to the
 * navigation rather than to `t`, and the spec's control for them: an instance on a node that
 * was removed but never destroyed records nothing.
 */

let hinted: string[] = [];
let posted: unknown[] = [];
const live: Array<{ destroy(): void }> = [];
const url = (path: string) => new URL(path, window.location.origin).href;
const go = (path: string) => window.history.pushState({}, '', path);
const runOutJitter = () => vi.advanceTimersByTimeAsync(31_000);

function mount(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}

beforeEach(() => {
    Object.assign(configStore, { projectid: 'p', key: 'k', baseLocale: 'en', sUserLocale: createSignal('es-es') });
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI' },
    } as never);
    currentlyLoadedLocale.set('es-es');
    writeEnabled.set(false);
    autoDiscovery.set(true);
    discoveryBaseLocaleOnly.set(false);
    LangsysApp.Translations.settle();
    _resetDiscoveryState();
    window.sessionStorage.clear();
    hinted = [];
    posted = [];
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockImplementation(async (u: string) => {
        hinted.push(u);
        return { status: true };
    });
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        posted.push(...(items as unknown[]));
        return { status: true } as never;
    });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
    go('/a');
});

afterEach(() => {
    for (const x of live) x.destroy();
    live.length = 0;
    (LangsysApp.Translations as unknown as { missingTokens: unknown[] }).missingTokens = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetDiscoveryState();
    writeEnabled.set(undefined);
    discoveryBaseLocaleOnly.set(false);
    Object.assign(configStore, { projectid: '', key: '' });
    document.body.innerHTML = '';
});

describe('HINT-13: the navigation entry point', () => {
    it('publishes a fresh t through tSignal, and sends nothing itself', async () => {
        const before = LangsysApp.Translations.tSignal.get();
        LangsysApp.notifyNavigation();
        expect(LangsysApp.Translations.tSignal.get()).not.toBe(before);
        await runOutJitter();
        expect(hinted).toEqual([]);
        expect(posted).toEqual([]);
    });

    it('a single-token Translate that stays mounted records its miss at the new URL', async () => {
        live.push(new Translate(mount('<p>Layout phrase</p>'), { category: 'UI' }));
        await runOutJitter();
        expect(hinted).toEqual([url('/a')]);
        go('/b');
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted).toEqual([url('/a'), url('/b')]);
    });

    it('an unknown content block that stays mounted records at the new URL', async () => {
        live.push(new Translate(mount('<p>Block one</p><p>Block two</p>'), { category: 'UI' }));
        await runOutJitter();
        go('/b');
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted).toEqual([url('/a'), url('/b')]);
    });

    it('a Phrase that stays mounted records at the new URL', async () => {
        const host = mount('Rich phrase');
        live.push(new Phrase(host, { category: 'UI' }));
        await runOutJitter();
        go('/b');
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted).toEqual([url('/a'), url('/b')]);
    });

    it('control: a Translate on a node removed from the page but never destroyed records nothing at the new URL', async () => {
        const host = mount('<p>Only on page A</p>');
        live.push(new Translate(host, { category: 'UI' }));
        await runOutJitter();
        expect(hinted).toEqual([url('/a')]);
        host.remove();
        go('/b');
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted).toEqual([url('/a')]);
    });

    it('control: a Phrase on a node removed from the page but never destroyed records nothing at the new URL', async () => {
        const host = mount('Only on page A');
        live.push(new Phrase(host, { category: 'UI' }));
        await runOutJitter();
        expect(hinted).toEqual([url('/a')]);
        host.remove();
        go('/b');
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted).toEqual([url('/a')]);
    });

    it('a content block already registered is not sent again after a navigation (GATE-5)', async () => {
        writeEnabled.set(true);
        live.push(new Translate(mount('<p>Block one</p><p>Block two</p>'), { category: 'UI' }));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted, 'registered once on mount').toHaveLength(1);
        go('/b');
        LangsysApp.notifyNavigation();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toHaveLength(1);
    });

    it('is idempotent: a second call for the same URL reports nothing more', async () => {
        live.push(new Translate(mount('<p>Layout phrase</p>'), { category: 'UI' }));
        await runOutJitter();
        go('/b');
        LangsysApp.notifyNavigation();
        LangsysApp.notifyNavigation();
        await runOutJitter();
        expect(hinted.filter((u) => u === url('/b'))).toHaveLength(1);
    });

    it('queues nothing again that is already registered (GATE-5)', async () => {
        writeEnabled.set(true);
        live.push(new Translate(mount('<p>Layout phrase</p>'), { category: 'UI' }));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toHaveLength(1);
        go('/b');
        LangsysApp.notifyNavigation();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(posted).toHaveLength(1);
    });
});

describe('GATE-9 holds on the content-block path, not only on t() misses', () => {
    const block = { custom_id: 'b-gate9', category: 'UI', content: '<p>A</p><p>B</p>', label: 'x', tokens: ['A', 'B'] };

    it('on, in a non-base locale: a write-enabled session does not register the block', async () => {
        writeEnabled.set(true);
        discoveryBaseLocaleOnly.set(true);
        await registerContentBlock(block as never);
        expect(posted).toEqual([]);
    });

    it('on, in a non-base locale: a read-only session does not report the page', async () => {
        discoveryBaseLocaleOnly.set(true);
        await registerContentBlock(block as never);
        await runOutJitter();
        expect(hinted).toEqual([]);
    });

    it('control: on, at the base locale, the block registers', async () => {
        writeEnabled.set(true);
        discoveryBaseLocaleOnly.set(true);
        currentlyLoadedLocale.set('en');
        await registerContentBlock(block as never);
        expect(posted).toHaveLength(1);
    });

    it('control: off, in the same locale, the block registers', async () => {
        writeEnabled.set(true);
        await registerContentBlock(block as never);
        expect(posted).toHaveLength(1);
    });
});
