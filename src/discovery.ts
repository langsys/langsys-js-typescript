import { LangsysAppAPI } from './api.js';
import { logger } from './logger.js';
import { autoDiscovery, sTranslations, writeEnabled } from './stores.js';

/**
 * Content-discovery hint lane.
 *
 * A public API key shipped in browser JS is extractable, so public keys are
 * read-only and the server decides per session whether writing is allowed. A
 * read-only session that finds unregistered content therefore can't register
 * it — instead it tells the server *where* to look, and our discovery renderer
 * loads that URL from an allow-listed IP where the very same SDK code path is
 * write-enabled and registers what it finds.
 *
 * The two lanes are mutually exclusive, and that is the loop-prevention
 * mechanism rather than a suppression flag: a write-enabled session registers
 * and structurally cannot hint, so the renderer can never hint at itself.
 *
 * Hints carry a URL and nothing else — never a phrase payload. Anonymous
 * callers can say "look here", never "store this".
 *
 * Everything here is browser-only. Under SSR there is no `window` and no
 * `sessionStorage`, and a server render would fire hints from the origin
 * server's single IP — concentrating the herd this module exists to disperse.
 */

/** Jitter bounds. Spreads arrival in time so a hot page can't spike the rate limiter. */
const HINT_MIN_DELAY_MS = 5_000;
const HINT_MAX_DELAY_MS = 30_000;

/**
 * Per-URL cap on remembered misses. These are only ever read locally, for the
 * opportunistic recheck below — they are never sent — so a bound costs nothing
 * and keeps a long-lived SPA session from growing without limit.
 */
const MAX_TRACKED_MISSES_PER_URL = 200;

const SESSION_KEY_PREFIX = 'langsys:hinted:';

interface TrackedMiss {
    category: string;
    phrase: string;
}

interface PendingHint {
    /** URL captured when the FIRST miss for this page was recorded. */
    url: string;
    misses: TrackedMiss[];
    timer: ReturnType<typeof setTimeout>;
}

/**
 * Keyed by captured URL, NOT one global queue. A client-side router swaps
 * routes without remounting the app or resetting module state, so one process
 * accumulates misses across many routes; batching them into a single hint would
 * attribute every one of them to whichever URL happened to be current.
 */
const pending = new Map<string, PendingHint>();

/** Set on 429 — the server is asking us to stop, so we stop for the session. */
let hintsDisabledForSession = false;

/** `sessionStorage` throws on ACCESS in Safari private mode and sandboxed iframes. */
function getSafeSessionStorage(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        const s = window.sessionStorage;
        s.getItem('__langsys_probe__');
        return s;
    } catch {
        return null;
    }
}

function alreadyHinted(url: string): boolean {
    const storage = getSafeSessionStorage();
    if (!storage) return false;
    try {
        return storage.getItem(SESSION_KEY_PREFIX + url) !== null;
    } catch {
        return false;
    }
}

function markHinted(url: string): void {
    const storage = getSafeSessionStorage();
    if (!storage) return;
    try {
        storage.setItem(SESSION_KEY_PREFIX + url, '1');
    } catch {
        // Quota or a hostile storage implementation — worst case we hint twice.
    }
}

/**
 * Canonical form for the hint URL and for the per-session dedup key.
 *
 * Without this, one campaign-tagged share link becomes N distinct URLs and
 * defeats both our per-session dedup and the server's per-URL dedup. The
 * server normalizes authoritatively too — it has to, since it can't stop an
 * old SDK build from sending raw hrefs.
 *
 * This tracking list matches `HintUrl::normalize()`. The SDK additionally
 * strips credential-shaped params (below), which the server does NOT — that
 * asymmetry is deliberate and safe (normalizing an already-stripped URL is
 * stable), and it exists because the client is the only leg that can stop a
 * credential leaving the browser at all. Revisit if the three-repo contract
 * decision moves the sanitization server-side.
 */
/**
 * Every `utm_*` param, matched by prefix rather than enumerated. An enumerated
 * list kept missing ones that exist in the wild (`utm_id`,
 * `utm_source_platform`, `utm_creative_format`), and each miss fragments the
 * dedup window into one render per campaign variant — silent, and paid per
 * link. Mirrors the server's `TRACKING_PREFIX`.
 */
const TRACKING_PREFIX = 'utm_';

const TRACKING_PARAMS = new Set([
    'gclid',
    'fbclid',
    'msclkid',
    'mc_cid',
    'mc_eid',
    'ref',
    'ref_src',
]);

/**
 * Query parameters that must never leave the browser in a report.
 *
 * This is a stronger requirement than the tracking denylist above, and for a
 * different reason. A reported URL is not merely *stored* — the discovery
 * renderer **visits it**. So a capability in a query string is not a privacy
 * leak, it is a replay: a magic-link or single-use token would be exercised by
 * our own infrastructure, potentially consuming it before the user clicks, or
 * causing the renderer to load a page as that user.
 *
 * Matched as substrings because the risky names are endlessly re-spelled
 * (`token`, `access_token`, `csrfToken`), and false positives are cheap here —
 * losing a query param costs the renderer some page fidelity, while keeping one
 * can cost a credential.
 *
 * A denylist is incomplete by construction and this is defence in depth, not a
 * guarantee. The durable fix is a decision shared with the server normalizer
 * and the renderer, since the SDK stripping a param buys nothing while the
 * other two legs accept it.
 */
const SENSITIVE_PARAM_FRAGMENTS = [
    'token',
    'secret',
    'password',
    'passwd',
    'apikey',
    'api_key',
    'authoriz',
    'session',
    'signature',
    'credential',
    'email',
];

/**
 * Short words that are credentials on their own but appear inside ordinary
 * routing params, so they are matched WHOLE rather than as substrings.
 * `code` is the OAuth authorization code — a genuine single-use credential —
 * while `postcode`, `country_code` and `product_code` are routes; `sig` is a
 * signature while `design` is not; `auth` is a credential while `author` is a
 * blog filter. Substring-matching these cost page fidelity for no safety.
 */
const SENSITIVE_PARAM_EXACT = new Set(['code', 'sig', 'auth', 'otp', 'nonce', 'key']);

function isSensitiveParam(lowerKey: string): boolean {
    if (SENSITIVE_PARAM_EXACT.has(lowerKey)) return true;
    return SENSITIVE_PARAM_FRAGMENTS.some((f) => lowerKey.includes(f));
}

export function normalizeHintUrl(href: string): string | null {
    try {
        const url = new URL(href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

        url.protocol = url.protocol.toLowerCase();
        url.hostname = url.hostname.toLowerCase();

        // Fragment-vs-route, not hash-vs-no-hash. `#pricing` is an anchor into
        // the current page and carries no routing information. `#/pricing` is
        // the entire route under HashRouter / Vue hash mode / Angular useHash —
        // stripping it collapses every route in such an app onto one key, so
        // per-session dedup would fire once for the whole application and the
        // single hint would point at the bare origin.
        //
        // `#!/…` is the older hashbang spelling (Angular 1, Vue hash mode) and
        // is equally load-bearing. Bare `#`, `#/` and `#!/` carry no route, so
        // they're dropped — keeping them would make `example.com/#/` a
        // different dedup key from `example.com/` for the same page. The
        // renderer applies the same rule on its side.
        if (!/^#!?\/.+/.test(url.hash)) url.hash = '';

        for (const key of [...url.searchParams.keys()]) {
            const k = key.toLowerCase();
            if (k.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(k) || isSensitiveParam(k)) {
                url.searchParams.delete(key);
            }
        }
        // Stable ordering so ?a=1&b=2 and ?b=2&a=1 dedup to one key.
        url.searchParams.sort();

        return url.toString();
    } catch {
        return null;
    }
}

/** Key-presence test. `in` walks the prototype chain — `'toString' in {}` is true. */
function isKnownPhrase(category: string, phrase: string): boolean {
    const bucket = sTranslations.get()[category || '__uncategorized__'];
    return !!bucket && Object.prototype.hasOwnProperty.call(bucket, phrase);
}

/**
 * Note a catalog miss for the page currently being viewed.
 *
 * Safe to call on every miss: it captures the URL, dedups per session, and
 * decides nothing. The lane choice happens when the timer fires.
 */
export function recordMissForDiscovery(category: string, phrase: string): void {
    // Covers RSC render, static generation at build time, and ISR revalidation
    // in one bail — none of which have a client seam to guard instead.
    if (typeof window === 'undefined') return;
    if (hintsDisabledForSession) return;

    // Captured HERE, at miss time — never read at fire time. A client-side
    // route change does not remount the app or reset this module, and the
    // jitter window is 5-30s, so reading `location` when the timer fires would
    // routinely report the page the user navigated TO rather than the page that
    // produced the miss. The renderer would then load a URL that doesn't
    // contain the content, find nothing, and the loop would silently no-op.
    // Optional-chained deliberately: this runs inside every `t()` miss, so an
    // unusual environment shape (a partial `window` in a test harness or an
    // embedded runtime) must degrade to "no hint" rather than throw out of the
    // caller's render.
    const href = window.location?.href;
    if (!href) return;
    const url = normalizeHintUrl(href);
    if (!url) return;

    if (alreadyHinted(url)) return;

    const existing = pending.get(url);
    if (existing) {
        if (
            existing.misses.length < MAX_TRACKED_MISSES_PER_URL &&
            !existing.misses.some((m) => m.category === category && m.phrase === phrase)
        ) {
            existing.misses.push({ category, phrase });
        }
        return;
    }

    const delay = HINT_MIN_DELAY_MS + Math.random() * (HINT_MAX_DELAY_MS - HINT_MIN_DELAY_MS);
    const entry: PendingHint = {
        url,
        misses: [{ category, phrase }],
        timer: setTimeout(() => void flushHint(url), delay),
    };
    // Never keep a Node event loop alive for a hint (jsdom/test runners).
    (entry.timer as unknown as { unref?: () => void }).unref?.();
    pending.set(url, entry);
}

async function flushHint(url: string): Promise<void> {
    const entry = pending.get(url);
    if (!entry) return;
    pending.delete(url);

    if (hintsDisabledForSession) return;

    // Mutual exclusion with the write lane. `true` means this session registers
    // its own misses and must never hint; `undefined` means authorization never
    // resolved, and hinting on an unknown state would report pages on behalf of
    // a session that may well have been write-enabled. Drop — a later miss
    // re-records once the state is known.
    if (writeEnabled.get() !== false) return;

    // Policy check, at the SEND site rather than the record site. Deliberate:
    // every producer feeding this lane — `t()` misses and unregistered content
    // blocks — passes through here, so one decision point covers all of them
    // and the next producer added doesn't have to remember. Evaluating it at
    // record time instead would also make "false until known" unsafe, silently
    // dropping early misses for keys that DO permit reporting.
    //
    // Independent of writeEnabled: the canonical public site is read-only AND
    // permitted to report, so these are two questions, never one.
    if (autoDiscovery.get() !== true) {
        // Debug level, not a warning. The severity tracks who chose the
        // condition, and this one was chosen deliberately by the person who
        // would receive the warning — so warning every session trains exactly
        // the wrong person to ignore warnings. The integrator is a different
        // audience, which is why the line exists at all: invisible by default,
        // reachable when someone goes looking. It says WHY rather than what,
        // so that search terminates at the answer instead of another question.
        logger.log('Discovery reporting is not permitted for this API key (auto_discovery disabled) — not sending');
        return;
    }

    // Opportunistic only: if a newer catalog happened to arrive during the
    // jitter (locale change, app-initiated refresh), everything we saw may now
    // be registered and the hint is pointless. We deliberately do NOT fetch in
    // order to check — a catalog GET runs the best-translations procedure over
    // the whole project, which is orders of magnitude more expensive than the
    // 204 it would be trying to avoid. Server-side dedup already collapses the
    // herd; this is a free win when it happens and nothing when it doesn't.
    if (entry.misses.every((m) => isKnownPhrase(m.category, m.phrase))) {
        markHinted(url);
        return;
    }

    // Fire-and-forget by design: one hint per URL per session, no retry, no
    // backoff, and no record of the outcome. Content that structurally can't be
    // discovered by a render — bare `t()` in a Server Component, which produces
    // inert HTML with no marker and no client-side call — must not be able to
    // generate a growing failure state here.
    markHinted(url);

    try {
        const response = await LangsysAppAPI.postDiscoveryHint(url);
        if (response.http?.status === 429) {
            hintsDisabledForSession = true;
            for (const stale of pending.values()) clearTimeout(stale.timer);
            pending.clear();
            logger.log('Discovery hints rate-limited; disabled for this session');
        }
    } catch (err) {
        // Inside a timer callback there is no caller to reject to — an
        // unhandled rejection here would surface in the customer's app.
        logger.warn('Discovery hint failed', err);
    }
}

/** Test/teardown hook — drops pending timers and re-enables hinting. */
export function _resetDiscoveryState(): void {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    hintsDisabledForSession = false;
}
