import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { _resetDiscoveryState, normalizeHintUrl, recordMissForDiscovery } from '../src/discovery.js';
import { autoDiscovery, sTranslations, writeEnabled } from '../src/stores.js';

/**
 * The discovery report lane. These were a session-scratchpad harness that got
 * wiped twice — evidence you cannot reproduce is a memory, not a test.
 */

const HREF = { value: 'https://site.local/page' };
const sessionStore = new Map<string, string>();

function installBrowserShim(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = {
        addEventListener: () => {},
        get location() {
            return {
                get href() {
                    return HREF.value;
                },
            };
        },
        sessionStorage: {
            getItem: (k: string) => sessionStore.get(k) ?? null,
            setItem: (k: string, v: string) => void sessionStore.set(k, v),
        },
    };
    g.sessionStorage = (g.window as Record<string, unknown>).sessionStorage;
    g.document = { addEventListener: () => {}, visibilityState: 'visible' };
}

function removeBrowserShim(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.sessionStorage;
}

/** Captured page_url values from hints the SDK actually sent. */
let sent: string[] = [];

beforeEach(() => {
    installBrowserShim();
    _resetDiscoveryState();
    sessionStore.clear();
    sent = [];
    HREF.value = 'https://site.local/page';
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
    });
    writeEnabled.set(false); // read-only session — the lane that reports
    autoDiscovery.set(true); // permitted, unless a test says otherwise
    vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockImplementation(async (url: string) => {
        sent.push(url);
        return { status: true };
    });
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetDiscoveryState();
    removeBrowserShim();
});

/** Run out the 5–30s jitter and let the async flush settle. */
async function runOutJitter(): Promise<void> {
    await vi.advanceTimersByTimeAsync(31_000);
}

describe('normalizeHintUrl', () => {
    it('strips tracking params but keeps routing query, sorted', () => {
        expect(normalizeHintUrl('https://a.com/p?utm_source=x&b=2&a=1&fbclid=z')).toBe('https://a.com/p?a=1&b=2');
    });

    it('drops plain anchors, which carry no routing information', () => {
        expect(normalizeHintUrl('https://a.com/pricing#features')).toBe('https://a.com/pricing');
    });

    it('KEEPS route-shaped fragments — stripping collapses a whole hash-routed app onto one key', () => {
        expect(normalizeHintUrl('https://a.com/#/products/42')).toBe('https://a.com/#/products/42');
        expect(normalizeHintUrl('https://a.com/#!/checkout')).toBe('https://a.com/#!/checkout');
    });

    it('distinguishes two routes of the same app', () => {
        expect(normalizeHintUrl('https://a.com/#/x')).not.toBe(normalizeHintUrl('https://a.com/#/y'));
    });

    it('drops bare # / #/ / #!/, which carry no route', () => {
        expect(normalizeHintUrl('https://a.com/#/')).toBe('https://a.com/');
        expect(normalizeHintUrl('https://a.com/#')).toBe('https://a.com/');
    });

    it('rejects non-http schemes and garbage', () => {
        expect(normalizeHintUrl('file:///etc/passwd')).toBeNull();
        expect(normalizeHintUrl('javascript:alert(1)')).toBeNull();
        expect(normalizeHintUrl('not a url')).toBeNull();
    });
});

describe('the report lane', () => {
    it('reports a genuine miss on a read-only session', async () => {
        recordMissForDiscovery('UI', 'Brand new phrase');
        await runOutJitter();
        expect(sent).toEqual(['https://site.local/page']);
    });

    it('names the MISS-time URL, not wherever the user navigated during the jitter', async () => {
        recordMissForDiscovery('UI', 'Phrase on page A');
        HREF.value = 'https://site.local/elsewhere';
        await runOutJitter();

        expect(sent).toContain('https://site.local/page');
        expect(sent).not.toContain('https://site.local/elsewhere');
    });

    it('reports each URL separately rather than batching misses across routes', async () => {
        recordMissForDiscovery('UI', 'Phrase A');
        HREF.value = 'https://site.local/second';
        recordMissForDiscovery('UI', 'Phrase B');
        await runOutJitter();

        expect([...sent].sort()).toEqual(['https://site.local/page', 'https://site.local/second']);
    });

    it('reports a URL at most once per session', async () => {
        recordMissForDiscovery('UI', 'Phrase A');
        recordMissForDiscovery('UI', 'Phrase B');
        await runOutJitter();
        recordMissForDiscovery('UI', 'Phrase C');
        await runOutJitter();

        expect(sent).toEqual(['https://site.local/page']);
    });

    it('never reports from a write-enabled session — the lanes are mutually exclusive', async () => {
        writeEnabled.set(true);
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual([]);
    });

    it('holds rather than reporting while capability is still unknown', async () => {
        writeEnabled.set(undefined);
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual([]);
    });

    it('never reports during SSR', async () => {
        removeBrowserShim();
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual([]);
    });
});

/**
 * auto_discovery is observable in exactly one of four cells: a write-enabled
 * session never reports anyway, so the flag is inert unless write_enabled is
 * false. Testing only the disabled cell would pass against an SDK that never
 * reports at all — GATE-7's failure wearing a permission's clothing — so the
 * positive control is what makes the negative one mean anything.
 */
describe('auto_discovery is a policy, independent of write capability', () => {
    it('POSITIVE CONTROL: read-only AND permitted reports (the canonical public site)', async () => {
        writeEnabled.set(false);
        autoDiscovery.set(true);
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual(['https://site.local/page']);
    });

    it('read-only and NOT permitted reports nothing', async () => {
        writeEnabled.set(false);
        autoDiscovery.set(false);
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual([]);
    });

    it('does not report while the permission is still unknown', async () => {
        writeEnabled.set(false);
        autoDiscovery.set(undefined);
        recordMissForDiscovery('UI', 'Phrase');
        await runOutJitter();
        expect(sent).toEqual([]);
    });
});

describe('content blocks feed the report lane', () => {
    it('reports a page whose unregistered content is a content block, not a t() miss', async () => {
        writeEnabled.set(false);
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems');

        await registerContentBlock({
            custom_id: 'a'.repeat(32),
            category: 'Blog',
            content: '<p>x</p>',
            label: 'l',
            tokens: ['Untranslated paragraph'],
        });

        expect(post).not.toHaveBeenCalled(); // read-only: registration correctly skipped
        await runOutJitter();
        expect(sent).toEqual(['https://site.local/page']); // …but the page is still reported
    });

    it('a write-enabled session registers the block and does NOT report', async () => {
        writeEnabled.set(true);
        const post = vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockResolvedValue({ status: true });

        await registerContentBlock({
            custom_id: 'b'.repeat(32),
            category: 'Blog',
            content: '<p>y</p>',
            label: 'l',
            tokens: ['Another paragraph'],
        });

        expect(post).toHaveBeenCalledOnce();
        await runOutJitter();
        expect(sent).toEqual([]);
    });
});

describe('TS-7: sensitive query params never leave the browser', () => {
    it('strips credential-shaped params, which the renderer would otherwise REPLAY', () => {
        // A reported URL is not just stored — the renderer visits it. A
        // magic-link or single-use token in a query string would be exercised
        // by our own infrastructure.
        expect(normalizeHintUrl('https://a.com/p?token=abc123&page=3')).toBe('https://a.com/p?page=3');
        expect(normalizeHintUrl('https://a.com/p?access_token=x&csrfToken=y')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p?email=a@b.com')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p?signature=s&sig=t&nonce=n')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p?api_key=k&apikey=k2&secret=s')).toBe('https://a.com/p');
    });

    it('still keeps ordinary routing params, so discovery keeps working', () => {
        expect(normalizeHintUrl('https://a.com/p?page=3&category=shoes&sort=asc')).toBe(
            'https://a.com/p?category=shoes&page=3&sort=asc',
        );
    });
});

describe('sensitive-param matching is whole-word where the word is ambiguous', () => {
    it('strips OAuth code but keeps postcode / country_code', () => {
        expect(normalizeHintUrl('https://a.com/p?code=oauth-grant')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p?postcode=SW1&country_code=gb')).toBe(
            'https://a.com/p?country_code=gb&postcode=SW1',
        );
    });

    it('strips sig and auth but keeps design and author', () => {
        expect(normalizeHintUrl('https://a.com/p?sig=abc&auth=xyz')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p?design=flat&author=jo')).toBe(
            'https://a.com/p?author=jo&design=flat',
        );
    });

    it('still strips the unambiguous ones as substrings', () => {
        expect(normalizeHintUrl('https://a.com/p?authorization=b&user_email=c&session_id=d')).toBe('https://a.com/p');
    });
});

describe('HINT-6 sync with the server normalizer', () => {
    it('strips every utm_* param by prefix, not an enumerated five', () => {
        // An enumerated list kept missing real ones, and each miss fragments
        // the dedup window into one render per campaign variant.
        expect(
            normalizeHintUrl('https://a.com/p?utm_id=1&utm_source_platform=x&utm_creative_format=y&keep=1'),
        ).toBe('https://a.com/p?keep=1');
    });

    it('still drops plain anchors', () => {
        expect(normalizeHintUrl('https://a.com/p#section-2')).toBe('https://a.com/p');
    });

    it('still drops bare route fragments that carry no route', () => {
        expect(normalizeHintUrl('https://a.com/p#/')).toBe('https://a.com/p');
        expect(normalizeHintUrl('https://a.com/p#!/')).toBe('https://a.com/p');
    });
});

/**
 * GATE-8 constraint 3 — the write fallback and the report lane must be gated by
 * ONE condition, not two that happen to co-occur.
 *
 * A server with no `write_enabled` has no `/discovery/hint` to receive a report
 * either. Deriving those two facts separately lets them diverge, and the
 * divergent state — reporting to an endpoint that does not exist — is silent by
 * construction. This asserts the pathological payload directly: `auto_discovery`
 * PRESENT and permissive, `write_enabled` ABSENT.
 */
describe('GATE-8 constraint 3: absent write_enabled gates the report lane off', () => {
    it('does not report when auto_discovery says yes but write_enabled is absent', async () => {
        const { LangsysApp } = await import('../src/langsys-app.js');
        const { createSignal } = await import('../src/signal.js');
        const { autoDiscovery: policy } = await import('../src/stores.js');

        vi.spyOn(globalThis, 'fetch').mockImplementation(
            async (url) =>
                ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    url: String(url),
                    headers: { get: () => 'application/json' },
                    // Legacy server: permissive policy, no capability field.
                    json: async () => ({ status: true, data: { key_type: 'read', auto_discovery: true } }),
                }) as unknown as Response,
        );

        await LangsysApp.init({
            projectid: 'p',
            key: 'k',
            UserLocaleStore: createSignal('en-us'),
            baseLocale: 'en-us',
        });

        expect(policy.get()).toBe(false); // one condition drove both

        recordMissForDiscovery('UI', 'Phrase on a legacy server');
        await runOutJitter();
        expect(sent).toEqual([]);
    });
});
