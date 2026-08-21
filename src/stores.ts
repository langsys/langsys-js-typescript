import { createSignal } from './signal.js';
import { persist } from './persist.js';
import type { iCategories } from './types/translations.js';
import type { iLangsysConfig } from './types/config.js';

const initialTranslations: iCategories = {
    __uncategorized__: {
        __category__: '__uncategorized__',
        __symbol__: '__uncategorized__',
    },
};

export const sTranslations = persist<iCategories>('translations', initialTranslations);

export const currentlyLoadedLocale = createSignal<string>('');

export const config: iLangsysConfig = {
    projectid: '',
    key: '',
    sUserLocale: createSignal<string>(''),
    baseLocale: 'en',
    debug: false,
    key_type: 'read',
};

/**
 * Server-computed write capability for THIS session. The single source of
 * truth for every write decision — never infer it from `key_type`, which
 * cannot express `ip_write` (read-only everywhere except from allow-listed
 * IPs, which is exactly how the discovery renderer registers content).
 *
 * Tri-state, and the three states are genuinely distinct:
 *   - `undefined` — not yet authorized. HOLD: neither register nor hint.
 *     Collapsing this to `false` would drop every miss that lands before
 *     `validate()` resolves and fire a spurious discovery hint for it.
 *   - `true`  — register missing tokens (never hint).
 *   - `false` — never attempt a write (no 403 churn); hint instead.
 *
 * Refreshed from `authorize-project` at init and from every catalog fetch.
 *
 * BROWSER-AUTHORITATIVE: only ever written when `window` exists. Write
 * capability is per-session (it varies by requester IP and by write grant),
 * while this module is a process-wide singleton — in a long-lived SSR server
 * shared across every request and every user, caching one request's answer
 * here would apply it to every later visitor. Under SSR it stays `undefined`,
 * which is the honest answer rather than a leaked one.
 */
export const writeEnabled = createSignal<boolean | undefined>(undefined);

/**
 * Whether this API key is permitted to report page URLs for content discovery.
 *
 * A POLICY, not a capability — deliberately independent of `writeEnabled`, and
 * the two must not be collapsed. `writeEnabled` answers "can this session write
 * from here"; this answers "may this key report at all". The canonical public
 * website is `writeEnabled: false` **and** `autoDiscovery: true` — read-only,
 * and permitted to report — which is exactly the case a single merged flag
 * would break.
 *
 * It exists because the SDK cannot tell whether it is running on a public
 * website. A mobile app holding a read key would otherwise report "page URLs"
 * that are not pages, and no heuristic settles it — our own URL heuristic is
 * already defeated by a routerless SPA. Beyond that, a customer may simply not
 * want visitors' page paths leaving the browser, whatever the SDK infers.
 *
 * Plain boolean rather than the tri-state `writeEnabled` uses, and false until
 * known. That is only safe because it is evaluated where the report is SENT
 * rather than where the miss is recorded: by then authorization has long since
 * resolved, and if it somehow hasn't, not reporting is the correct conservative
 * default. Checked at collection time instead, false-until-known would silently
 * drop early misses for keys that do permit reporting.
 */
export const autoDiscovery = createSignal<boolean | undefined>(undefined);

/**
 * Server-authoritative cap on items per `/translatable-items` request, from
 * `langsys_settings.translatable_items.batch_limit` on the authorization
 * response. Never hardcode it: if the server lowers its limit, an SDK sending
 * its own idea of a batch has every oversized request rejected, and those
 * phrases are never registered — silently, for every writing session.
 *
 * The default matches the server's own default so behaviour is unchanged
 * against a backend that doesn't send it.
 */
export const batchLimit = createSignal<number>(200);

/**
 * Record the server's write decision. No-ops during SSR — see the
 * browser-authoritative note on `writeEnabled`.
 */
export function setWriteEnabled(value: boolean | undefined): void {
    if (typeof window === 'undefined') return;
    if (typeof value !== 'boolean') return;
    if (writeEnabled.get() !== value) writeEnabled.set(value);
}
