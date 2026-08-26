import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { registerContentBlock } from '../src/content-block.js';
import { _resetDiscoveryState, normalizeHintUrl, recordMissForDiscovery } from '../src/discovery.js';
import fragmentFixture from './fixtures/hint-url-fragment-reference.json';
import { logger } from '../src/logger.js';
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

describe('TS-7: a credential-shaped param declines the WHOLE report', () => {
    it('returns null rather than a stripped URL, because the renderer VISITS what we send', () => {
        // Stripping the param produced a URL that is no longer the page the
        // miss came from: the renderer loads a different page and registers
        // what it finds there, and every page distinguished only by that param
        // collapses onto one dedup key. Both failures are silent. Declining is
        // the honest outcome — the page goes undiscovered and nothing wrong is
        // registered in its name.
        expect(normalizeHintUrl('https://a.com/p?token=abc123&page=3')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?access_token=x&csrfToken=y')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?email=a@b.com')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?signature=s&sig=t&nonce=n')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?apikey=k&secret=s')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?otp=123456')).toBeNull();
    });

    it('still keeps ordinary routing params, so discovery keeps working', () => {
        expect(normalizeHintUrl('https://a.com/p?page=3&category=shoes&sort=asc')).toBe(
            'https://a.com/p?category=shoes&page=3&sort=asc',
        );
    });
});

describe('route params that merely LOOK like credentials are carried', () => {
    // The regression this pair exists to stop: `key` and `code` were on the
    // whole-word list, so `?key=pricing` was destroyed and every tab of that
    // page became the same dedup key. A stripped route param costs every page
    // distinguished by it, permanently, with all statuses reporting success.
    it('carries ?key=, a tab selector on exactly the pages discovery hunts', () => {
        expect(normalizeHintUrl('https://a.com/plans?key=pricing')).toBe('https://a.com/plans?key=pricing');
        expect(normalizeHintUrl('https://a.com/plans?key=enterprise')).not.toBe(
            normalizeHintUrl('https://a.com/plans?key=pricing'),
        );
    });

    it('carries a bare ?code=, which is a country or a coupon far more often than a grant', () => {
        expect(normalizeHintUrl('https://a.com/shop?code=US')).toBe('https://a.com/shop?code=US');
        expect(normalizeHintUrl('https://a.com/shop?code=SAVE20')).toBe('https://a.com/shop?code=SAVE20');
    });

    it('declines ?code= only when an OAuth state marker rides along', () => {
        expect(normalizeHintUrl('https://a.com/cb?code=abc&state=xyz')).toBeNull();
        expect(normalizeHintUrl('https://a.com/cb?code=abc&session_state=xyz')).toBeNull();
    });

    it('keeps design/author/postcode/country_code, which normalization must not newly catch', () => {
        expect(normalizeHintUrl('https://a.com/p?design=flat&author=jo')).toBe(
            'https://a.com/p?author=jo&design=flat',
        );
        expect(normalizeHintUrl('https://a.com/p?postcode=SW1&country_code=gb')).toBe(
            'https://a.com/p?country_code=gb&postcode=SW1',
        );
        expect(normalizeHintUrl('https://a.com/p?product_code=X1&state=california')).toBe(
            'https://a.com/p?product_code=X1&state=california',
        );
    });
});

describe('param matching is separator-insensitive', () => {
    it('catches every spelling of api key — the hyphen form used to sail through', () => {
        // `api_key` matched the literal fragment; `api-key` and `x-api-key`
        // matched nothing, so the two commonest real spellings of the thing
        // this list exists to catch were transmitted verbatim.
        expect(normalizeHintUrl('https://a.com/p?api-key=k')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?x-api-key=k')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?api_key=k')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?apiKey=k')).toBeNull();
    });

    it('catches the compound auth spellings left uncovered by dropping `code`', () => {
        expect(normalizeHintUrl('https://a.com/p?auth_code=x')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?access-code=x')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?oauth_verifier=x')).toBeNull();
    });

    it('still strips the unambiguous ones as substrings', () => {
        expect(normalizeHintUrl('https://a.com/p?authorization=b')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?user_email=c')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?session_id=d')).toBeNull();
    });
});

describe('credentials hidden in the fragment', () => {
    // `searchParams` cannot see these, and the fragment is deliberately
    // PRESERVED by normalization (HINT-6), so a route-shaped fragment carrying
    // a grant would otherwise leave the browser verbatim.
    const fixture = fragmentFixture as {
        cases: { id: string; url: string; expect: string; expected_url?: string }[];
    };

    for (const c of fixture.cases) {
        it(`${c.expect}s: ${c.id}`, () => {
            if (c.expect === 'decline') {
                expect(normalizeHintUrl(c.url)).toBeNull();
            } else {
                expect(normalizeHintUrl(c.url)).toBe(c.expected_url);
            }
        });
    }

    it('reads the whole fragment as pairs when there is no ? at all', () => {
        // The implicit-flow shape. A ?-tail-only parser misses it silently.
        expect(normalizeHintUrl('https://a.com/cb#id_token=x')).toBeNull();
        expect(normalizeHintUrl('https://a.com/cb#refresh_token=x&scope=openid')).toBeNull();
    });

    it('ignores fragment segments with no `=`, which are routes and anchors', () => {
        expect(normalizeHintUrl('https://a.com/p#/products/42')).toBe('https://a.com/p#/products/42');
        expect(normalizeHintUrl('https://a.com/p#!/checkout')).toBe('https://a.com/p#!/checkout');
    });

    it('applies the OAuth co-occurrence rule across the fragment too', () => {
        expect(normalizeHintUrl('https://a.com/app#/cb?code=abc&state=xyz')).toBeNull();
        // …and still leaves a bare fragment `code` alone.
        expect(normalizeHintUrl('https://a.com/app#/shop?code=US')).toBe('https://a.com/app#/shop?code=US');
    });
});

describe('HINT-12: a declined URL crosses no boundary', () => {
    // The observable form of the leg obligation. Internal check-ordering cannot
    // be mutation-tested — the gate returns null and the mutated URL object is
    // discarded, so ordering changes nothing a caller can see. The obligation
    // that IS observable sits at the seams: for a matching URL, zero bytes of
    // it reach the transport, and nothing derived from it lands in SDK-side
    // state — the per-session hint memory included.
    const SECRET_PATH = 'reset-password';
    const SECRET_VALUE = 'SECRETVALUE123';
    const DECLINED = `https://site.local/${SECRET_PATH}?token=${SECRET_VALUE}`;

    /** Everything the SDK let out or wrote down, as one searchable blob. */
    function everythingObservable(): string {
        return [...sent, ...[...sessionStore.entries()].flat()].join('\u0000');
    }

    it('sends nothing and stores nothing for a declined URL', async () => {
        HREF.value = DECLINED;
        recordMissForDiscovery('UI', 'Some phrase');
        await runOutJitter();

        expect(sent).toEqual([]);
        expect([...sessionStore.keys()]).toEqual([]);
    });

    it('leaks no fragment of it either — not the path, not the value', async () => {
        // Stronger than "no exact match". A stripped URL, a hash of it, a
        // truncation, or a hint-memory key derived from it would all carry
        // something recognisable; none of those may appear anywhere.
        HREF.value = DECLINED;
        recordMissForDiscovery('UI', 'Some phrase');
        await runOutJitter();

        const observable = everythingObservable();
        expect(observable).not.toContain(SECRET_PATH);
        expect(observable).not.toContain(SECRET_VALUE);
        expect(observable).not.toContain('site.local');
    });

    it('positive control: a carried URL DOES cross both seams', async () => {
        // Without this the two assertions above are satisfied by a lane that
        // does nothing at all, which is the failure mode they exist to rule out.
        HREF.value = 'https://site.local/plans?key=pricing';
        recordMissForDiscovery('UI', 'Some phrase');
        await runOutJitter();

        expect(sent).toEqual(['https://site.local/plans?key=pricing']);
        expect([...sessionStore.keys()]).toEqual(['langsys:hinted:https://site.local/plans?key=pricing']);
    });
});

describe('declining is all-or-nothing', () => {
    // The property that makes the two legs agree without a shared contract: a
    // URL that PASSES the gate is byte-identical whatever matched, because the
    // gate runs before any mutation and returns null rather than a partial.
    // Without this, a leg that declines more would also emit different bytes
    // for the URLs it keeps, and the dedup keys would drift apart.
    it('returns null, not a URL with the tracking params already stripped', () => {
        // Mutation-checked, and the first version of this comment was wrong.
        // It claimed to detect the tracking-deletion pass being moved ABOVE the
        // gate. It cannot: the gate returns null and the mutated URL object is
        // discarded, so the return value is null either way. That ordering is
        // real and worth keeping, but it is NOT observable through this
        // function's output and therefore cannot be pinned from out here.
        //
        // What this does kill is strip-reversion — a gate that deletes the
        // offending param and carries on instead of declining. Under that
        // mutant these return 'https://a.com/p?page=3': a real, plausible URL
        // for a page we refused to report.
        expect(normalizeHintUrl('https://a.com/p?utm_source=x&token=abc&page=3')).toBeNull();
        expect(normalizeHintUrl('https://a.com/p?fbclid=z&sig=abc')).toBeNull();
    });

    it('leaves a carried URL identical whether or not the gate had anything to consider', () => {
        // Same route params, one URL carrying a name the gate inspects and
        // clears, one carrying nothing it looks at twice. Same output.
        expect(normalizeHintUrl('https://a.com/p?author=jo&page=3')).toBe('https://a.com/p?author=jo&page=3');
        expect(normalizeHintUrl('https://a.com/p?design=flat&page=3')).toBe('https://a.com/p?design=flat&page=3');
    });
});

describe('declining tells the developer why', () => {
    // Behaviour with no observable trace is undiscoverable by construction:
    // otherwise a developer staring at the one page that never gets translated
    // has no way to learn that we refused to report it.
    it('names the offending param, in the spelling the page actually uses', () => {
        const wasDebug = logger.debugEnabled;
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        logger.debugEnabled = true;
        try {
            expect(normalizeHintUrl('https://a.com/p?X-Api-Key=abc')).toBeNull();
            const said = spy.mock.calls.flat().join(' ');
            expect(said).toContain('declined');
            expect(said).toContain('X-Api-Key');
            expect(said).toContain('query string');
            // The NAME, never the value.
            expect(said).not.toContain('abc');
        } finally {
            logger.debugEnabled = wasDebug;
            spy.mockRestore();
        }
    });

    it('names a FRAGMENT param in the page\'s own spelling too', () => {
        const wasDebug = logger.debugEnabled;
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        logger.debugEnabled = true;
        try {
            expect(normalizeHintUrl('https://a.com/cb#Access_Token=secretvalue')).toBeNull();
            const said = spy.mock.calls.flat().join(' ');
            expect(said).toContain('declined');
            expect(said).toContain('Access_Token');
            // Says WHERE, and says the right where. Calling this a "query
            // parameter" while the developer stares at a URL with no query
            // string at all teaches them to distrust the notice.
            expect(said).toContain('fragment');
            expect(said).not.toContain('query string');
            expect(said).not.toContain('secretvalue');
        } finally {
            logger.debugEnabled = wasDebug;
            spy.mockRestore();
        }
    });

    it('says nothing when the URL is fine', () => {
        const wasDebug = logger.debugEnabled;
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        logger.debugEnabled = true;
        try {
            expect(normalizeHintUrl('https://a.com/plans?key=pricing')).not.toBeNull();
            expect(spy.mock.calls.flat().join(' ')).not.toContain('declined');
        } finally {
            logger.debugEnabled = wasDebug;
            spy.mockRestore();
        }
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
