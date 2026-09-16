# Plan — a client must not register text a server already translated

Status: implemented and green, uncommitted. Commits wait on the operator's word in my tab.

Outcome: both pieces landed as described below. The wire name is `discovery_base_locale_only`,
agreed with Langsys, who confirmed it rides the same top-level slot as `write_enabled` on both
catalog routes, so nothing needs stripping before caching. The marker shape was agreed with the
PHP and Laravel lanes against their own measurements: PHP's `translatePage()` will write it at
the document root, Laravel ships a Blade directive for app layouts it does not own, and the JSON
side is a sibling manifest rather than a wrapper, so no Inertia consumer breaks. Tests:
`base-locale-gate` (10) and `resolved-marker` (14), both red before the code and mutation-checked
in an isolated copy — 5 mutants for the gate, 6 for the marker, each reddening only what it
should.

## The defect, measured here at 8562371

`Translations.missingToken` records and queues a miss without ever comparing the loaded
locale with the base locale. `recordMissForDiscovery` is called on the same path. The only
base-locale comparison in the core is `translate.ts:371`, and it gates a render pass, not
recording.

So on a page a server SDK rendered in Spanish:

- a write-enabled session registers the Spanish string as a new SOURCE phrase;
- a read-only session sends a discovery hint for a localized URL, and the renderer visits
  it and finds the same Spanish text.

Legacy servers already send translated text and cannot be made to stop, so the core has to
account for it. Raised by the Laravel lane, verified at 8562371 by the Reviewer and again
here.

## Ruling (operator, relayed by the Reviewer, with its amendment)

1. **A base-locale gate on the miss path, both lanes.** NOT a client config option: a
   **project setting** delivered in the handshake, default off, honoured with no local
   override so there is one source of truth.
   - `GET /api/authorize-project/{project}`: inside `data`, beside `key_type`.
   - `/translations` and `/translations/data`: on the envelope, beside `words`.
   - Absent = off, which is also the state until the field is on the wire.
   - Proposed wire name `discovery_base_locale_only`; being agreed with Langsys.
2. **A producer-side "already resolved" marker**, so a server SDK can tag what it rendered
   and the client records no miss for it. Agreed directly with PHP and Laravel:
   - `data-ls-resolved="<locale>"` on `<html>` or any ancestor element, canonical lowercase
     `xx-yy`; `data-langsys-resolved` accepted on read (MARK-2); empty value means resolved,
     locale unstated.
   - Nearest ancestor wins; `="false"` / `="0"` opts a subtree back out, the convention
     `isPhraseMarked` already uses.
   - JSON props: a sibling manifest of resolved prop paths, never a wrapper object around
     the string — `props.errors.email` is a string and templates render it directly. Consumed
     by the app or binding; the core needs no API for it.

## What each piece covers, and what it does not

- Phrase hosts are already covered: `isPhraseMarked` reads both spellings, and both the
  `<Translate>` walker and the tokenizer return at such an element.
- Content-block hosts are NOT: the core writes `data-ls-contentblock` and never reads it.
- Bare server-printed text (Blade `@t`, fill-mode `__()`) has no host at all, so only the
  document-level marker or the project gate covers it.
- The core touches the DOM only in `Translate` (design invariant 5), so the marker is
  honoured on the `<Translate>` and `<Phrase>` paths. A bare `t()` call holding a
  server-translated string is covered by the gate, not the marker.

## Trade-off to document

With the gate on, an English fallback appearing on a localized page is no longer discovered
from that page. That is the point of the setting and the reason it defaults to off.

## Implementation sketch

- `stores.ts`: a policy signal beside `autoDiscovery`, never persisted, never cached.
- `translations.ts`: read the field where `write_enabled` is read now — `applyWriteEnabled`'s
  callers, i.e. `applyAuthorization` and every catalog fetch — so a change mid-session is
  picked up without re-running `init()`. Gate `missingToken` before both
  `recordMissForDiscovery` and the queue push.
- `translate.ts`: resolve the nearest `data-ls-resolved` ancestor for the host, and suppress
  recording for tokens from that subtree. DOM reads stay in this file.
- `content-block.ts`: `registerContentBlock` already declines on `catalogUnavailable`; the
  resolved marker is the same shape of decline.

## Tests, red-first, with a positive control for each gate

No shared fixture exists for either piece, so both get controls rather than vectors:

- gate on + non-base locale: nothing queued, no hint; control: same miss at the base locale
  still registers, and control: gate off at a non-base locale still registers.
- marker present: nothing queued, no hint, on the `<Translate>` and `<Phrase>` paths;
  control: the same markup without the marker registers; control: `="false"` on a subtree
  inside a marked document registers again.
- both spellings read; nearest-ancestor wins.
- the field is honoured from BOTH handshakes, and a cached artifact never carries it
  (GATE-4's shape).

## Rows

- The gate and the marker are behaviour no rule in the pinned spec names. CONFORMANCE is
  pinned to `5cff03a1` / blob `5c5c0723` (specVersion 8.0.1); the MSG family, including
  MSG-5, arrived at spec HEAD `70320628` / blob `f8ff6e1e` (8.1.0) and this file has not
  been re-audited against it.
- MSG-5 cross-reference: an entry is rendered by `t(entry.template, category, entry.params)`
  and `message` is never a lookup key, so server messages are already safe by rule — the
  exposure is `t()`, `@t` and fill-mode pages that also run a JS SDK.
- Record both under "Beyond the spec" until Langsys lands the spec line, then move them.
