// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { generateCustomId, tokenizeElement } from '../src/content-block.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { LangsysApp } from '../src/langsys-app.js';
import { Phrase } from '../src/phrase.js';
import { autoDiscovery, catalogUnavailable, currentlyLoadedLocale, discoveryBaseLocaleOnly, sTranslations, writeEnabled } from '../src/stores.js';
import { Translate } from '../src/translate.js';

/**
 * `data-ls-resolved` — a producer's statement that the text inside is already resolved,
 * so a reader records no miss for it on either lane.
 *
 * Agreed on this shape with the PHP and Laravel lanes, each measuring their own side:
 * PHP's `translatePage()` writes it at the document root, which is the only place a core
 * sees the whole document; Laravel ships a Blade directive, because the `<html>` tag
 * belongs to the application and a binding does not rewrite an app's markup. Hence the
 * attribute is INHERITED — text a server printed inline has no element of its own.
 *
 * It says nothing about identity, deliberately: a stamped block inside a resolved scope
 * keeps its id and still translates on a later render. It is also not `translate="no"`,
 * which means do-not-machine-translate to a browser and would block that later render.
 *
 * The opt-out is the one both SDKs already share for marker attributes: `false` and `0`
 * opt out, and nothing else does — `no` and `off` read as ON.
 */

const SPANISH = 'Hola mundo';
const priv = () => LangsysApp.Translations as unknown as { missingTokens: Array<{ token: string }> };
const queue = () => priv().missingTokens.map((m) => m.token);
const settle = () => vi.advanceTimersByTimeAsync(60);

let posted: string[] = [];
let hinted: string[] = [];
const live: Array<{ destroy(): void }> = [];

function seedUI(entries: Record<string, unknown> = {}) {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        UI: { __category__: 'UI', __symbol__: 'UI', ...entries },
    } as never);
}

interface MountOptions {
    /** Value for the document-level marker; omit for an unmarked document. */
    marker?: string;
    /** Spelling to write it in. Defaults to the canonical one. */
    markerAttr?: string;
    /** An attribute written on the host itself, for nearest-ancestor cases. */
    hostAttr?: [string, string];
}

async function mount(html: string, options: MountOptions = {}): Promise<HTMLElement> {
    if (options.marker !== undefined) {
        document.documentElement.setAttribute(options.markerAttr ?? 'data-ls-resolved', options.marker);
    }
    const host = document.createElement('div');
    if (options.hostAttr) host.setAttribute(options.hostAttr[0], options.hostAttr[1]);
    host.innerHTML = html;
    document.body.appendChild(host);
    live.push(new Translate(host, { category: 'UI' }));
    await settle();
    return host;
}

beforeEach(() => {
    _resetDiscoveryState();
    // The hint lane remembers reported URLs in sessionStorage, which outlives a test in
    // this environment. Without clearing it, a test that hints silences the NEXT one on
    // the same URL — and the control "unmarked, the same session does report" then fails
    // under an unrelated mutation, which is a control measuring leakage rather than the
    // behaviour it names.
    window.sessionStorage.clear();
    seedUI();
    currentlyLoadedLocale.set('es-es');
    catalogUnavailable.set(false);
    discoveryBaseLocaleOnly.set(false);
    writeEnabled.set(true);
    autoDiscovery.set(true);
    LangsysApp.Translations.settle();
    priv().missingTokens.length = 0;
    posted = [];
    hinted = [];
    vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
        for (const item of items as Array<Record<string, unknown>>) posted.push(String(item.phrase ?? item.custom_id));
        return { status: true } as never;
    });
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockImplementation(async (url: string) => {
        hinted.push(url);
        return { status: true };
    });
    for (const m of ['log', 'warn', 'error', 'info', 'group', 'groupCollapsed', 'groupEnd'] as const) {
        vi.spyOn(console, m).mockImplementation(() => {});
    }
    vi.useFakeTimers();
});

afterEach(() => {
    for (const t of live) t.destroy();
    live.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetDiscoveryState();
    priv().missingTokens.length = 0;
    writeEnabled.set(undefined);
    for (const attr of ['data-ls-resolved', 'data-langsys-resolved']) document.documentElement.removeAttribute(attr);
    document.body.innerHTML = '';
});

describe('text inside a resolved scope is never recorded', () => {
    it('a single-token host registers nothing', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es' });
        expect(queue()).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(posted).toEqual([]);
    });

    it('control: the same host in an unmarked document registers its text', async () => {
        await mount(`<p>${SPANISH}</p>`);
        expect(queue()).toEqual([SPANISH]);
    });

    it('a multi-token block is not registered', async () => {
        await mount('<p>Compra ahora</p><p>Ahorra mas</p>', { marker: '' });
        expect(posted).toEqual([]);
    });

    it('control: the same block in an unmarked document is registered', async () => {
        await mount('<p>Compra ahora</p><p>Ahorra mas</p>');
        expect(posted).toHaveLength(1);
    });

    it('a <Phrase> host registers nothing', async () => {
        document.documentElement.setAttribute('data-ls-resolved', 'es-es');
        const host = document.createElement('span');
        host.textContent = SPANISH;
        document.body.appendChild(host);
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(queue()).toEqual([]);
    });

    it('control: the same <Phrase> host in an unmarked document registers', async () => {
        const host = document.createElement('span');
        host.textContent = SPANISH;
        document.body.appendChild(host);
        live.push(new Phrase(host, { category: 'UI' }));
        await settle();
        expect(queue()).toEqual([SPANISH]);
    });

    it('the read lane is silent too: no discovery hint from a resolved page', async () => {
        writeEnabled.set(false);
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es' });
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toEqual([]);
    });

    it('control: unmarked, the same read-only session does report', async () => {
        writeEnabled.set(false);
        await mount(`<p>${SPANISH}</p>`);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toHaveLength(1);
    });
});

describe('a bare t() is outside the rule: it has no subtree, and GATE-9 governs it', () => {
    // The Test's negative control from spec 8.2.10. A reader that walked up from any
    // call site would suppress these, and pass every case above; these fail it.
    const bareT = () => LangsysApp.Translations.t as unknown as (phrase: string, category: string) => string;

    it('records its miss under a resolved document root', async () => {
        document.documentElement.setAttribute('data-ls-resolved', 'es-es');
        bareT()('Pay now', 'UI');
        await settle();
        expect(queue()).toEqual(['Pay now']);
    });

    it('and on the read lane, reports the page', async () => {
        document.documentElement.setAttribute('data-ls-resolved', 'es-es');
        writeEnabled.set(false);
        bareT()('Pay now', 'UI');
        await vi.advanceTimersByTimeAsync(31_000);
        expect(hinted).toHaveLength(1);
    });

    it('while a resolved host on the same page registers nothing', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es' });
        bareT()('Pay now', 'UI');
        await settle();
        expect(queue()).toEqual(['Pay now']);
    });
});

describe('how the marker is read', () => {
    it('the legacy spelling is accepted, as MARK-2 requires', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es', markerAttr: 'data-langsys-resolved' });
        expect(queue()).toEqual([]);
    });

    it('a bare attribute means resolved, since a layout often cannot know the locale', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: '' });
        expect(queue()).toEqual([]);
    });

    it('nearest ancestor wins: a subtree opts back out with false', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es', hostAttr: ['data-ls-resolved', 'false'] });
        expect(queue()).toEqual([SPANISH]);
    });

    it('and with 0, trimmed and case-insensitive, but not with "no" or "off"', async () => {
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es', hostAttr: ['data-ls-resolved', ' 0 '] });
        expect(queue(), '0 opts out').toEqual([SPANISH]);

        priv().missingTokens.length = 0;
        document.body.innerHTML = '';
        await mount(`<p>${SPANISH}</p>`, { marker: 'es-es', hostAttr: ['data-ls-resolved', 'no'] });
        expect(queue(), '"no" is not an opt-out under the shared rule').toEqual([]);
    });
});

describe('the marker says nothing about identity or rendering', () => {
    it('the block still stamps the id the tokenizer derives', async () => {
        const host = await mount('<p>Compra ahora</p><p>Ahorra mas</p>', { marker: 'es-es' });
        const derived = generateCustomId('UI', tokenizeElement(host).tokens);
        expect(host.getAttribute('data-ls-contentblock')).toBe(derived);
    });

    it('a translation the catalog holds is still rendered', async () => {
        seedUI({ [SPANISH]: 'Hola mundo!' });
        const host = await mount(`<p>${SPANISH}</p>`, { marker: 'es-es' });
        expect(host.textContent).toBe('Hola mundo!');
        expect(queue()).toEqual([]);
    });
});
