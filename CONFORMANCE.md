# Conformance — `langsys-js-typescript`

| | |
|---|---|
| **SDK** | `langsys-js-typescript` (browser reference implementation) |
| **Profiles** | `all`, `browser` |
| **specVersion** | 8 |
| **Spec revision read** | round-2 tree (GATE-8, WIRE-3 v4, HINT-6 dispatch/dedup split) |
| **SDK revision** | `feature/838_write_key_gating_reland`, cut from `origin/main` `2d7b11f` (v0.6.5) |
| **Suite** | 220 tests, `npm test` |

**About this re-land.** This branch is cut from `origin/main` `2d7b11f` (v0.6.5) rather
than rebased, and the 838 surface is ported semantically. One thing was deliberately NOT
carried: the MD5 UTF-8 fix and its legacy export, because main already ships both (verified
bit-identical across 15 vectors, 0 disagreements).

**Correction.** This paragraph also claimed the NUL-byte fix was already on main. It was
not, and the claim was checked with a measurement that had no positive control — the same
error this document exists to catch. `src/interpolate.ts` carried one literal `0x00` at
`texts.join(…)` on every commit from `origin/main` through this branch, which makes git
classify the file as binary: no diff, no blame, no three-way merge. Every change to that
file, including this branch's own, was invisible to review while still shipping. The fix is
Gianluca Capra's, in PR #3 (`e1e9e83`, 2026-08-10) — written as the `'\0'` escape — the
first fix, and the one carried here. It was not the only one: a second fix landed
independently on the original 838 branch a day later and was lost with it. Both
blob-verified at the time (parent carries the NUL, commit does not). It is now carried here with a comment saying why
the escape must stay an escape. What *was* carried from that work is the conformance coverage — main fixed the
hash and left an ASCII-only suite, so the codepoint-constructed vectors here are the
only non-ASCII coverage the repo has: **8 strings built with
`String.fromCodePoint`** — Latin-1, NFC and NFD forms of the same grapheme, CJK, Cyrillic,
Greek, Hebrew, Arabic and a non-BMP codepoint — exercised across 19 tests. Counting the
strings rather than the assertions matters: an implementation can pass every ASCII and
Latin-1 case while being wrong above the BMP, so it is the spread of codepoints that
carries the coverage, not the number of expectations.

**What surfaced while writing this file.** Three things, each worth more than the row it
came from. First, grading my own evidence against CONF-2 rather than against my
memory of having tested things: nearly everything here is proven by *mocked* transport,
which CONF-2 explicitly does not count — so the honest status of most rows is
`provisional`, and that is a property of the shared contract fixture not existing rather
than of the behaviour being doubtful. Second, filling in the Test column exposed rules I
believe are satisfied but have no test pointing at them at all (GATE-3, GATE-4, CAT-3, REG-12,
WIRE-4, SSR-3). A row I can only defend by reading the code is exactly the row CONF-1
exists to distrust, so those are marked `provisional (no test)` rather than
`implemented`.

Third, filling in REG-9 found a live defect rather than a missing test: the batch size was
hardcoded while the server returns its own limit on authorization. If the server lowered
its cap, every oversized request would be rejected and those phrases never registered —
silently, for every writing session. Fixed while writing this row, which is the best
argument I have for the format.

**On the observation point.** HINT-12 was `partial` while its evidence was an
internal-ordering test, because that test could not be made to fail: the gate returns
`null` and discards the URL object, so ordering is invisible to any caller. Re-pointing the
assertion at the transport and persistence seams made the same obligation falsifiable —
two mutants that previously passed now turn it red. Where a row is stuck at `partial`, the
question worth asking first is whether the obligation is being observed in the wrong place.

**Commit citations.** Only SHAs reachable from a live ref are cited — `origin/main`,
this branch, or a GitHub PR head. The original 838 branch was deleted after its work was
re-derived onto the reland line, so its SHAs no longer resolve in a fresh clone; changes
that landed there are described and dated instead. Don't re-add a bare SHA for them: it
reads as verifiable and isn't.

**Evidence grades** follow CONF-2: `live` (real server), `contract` (stateful double),
`mock` (canned responses — does not meet the bar), `none`. Every `mock` and `none` row
is `provisional` regardless of how confident I am in the behaviour.

---

## Status

| Rule | Status | Evidence | Test |
|---|---|---|---|
| GATE-1 | provisional | mock | `write-lane` TS-1 · `discovery` mutual-exclusion · `grant-lane` applies re-authorized capability. IP arm verified live once, **not reproducible** |
| GATE-2 | provisional | mock | `grant-lane` "flushes what was held once capability resolves true" |
| GATE-3 | provisional (no test) | none | Code: `writeEnabled` is never `persist()`-backed; `setWriteEnabled` no-ops without `window`. **Carve-out declared below.** |
| GATE-4 | provisional (no test) | none | Code: `getTranslations` takes `response.data` only; the authorize body is never cached |
| GATE-5 | provisional | mock | `discovery` "a write-enabled session registers the block and does NOT report" (cache written only after confirmed acceptance) |
| GATE-6 | provisional | mock | `discovery` "never reports from a write-enabled session" + content-block pair |
| GATE-7 | provisional | mock | `discovery` "reports a page whose unregistered content is a content block, not a t() miss" — **both directions** |
| GATE-8 | implemented | mock | `grant-lane` GATE-8 block (write/read fallback, `ip_write` refused, re-evaluated per response, report lane off from the same condition, permissive policy cannot re-enable it) + `discovery` constraint-3 block |
| CAT-1 | implemented | n/a (pure) | `translations` lookup suite + `write-lane` TS-3 (prototype-named phrase) |
| CAT-2 | implemented | n/a (pure) | `translations` "returns the phrase as fallback when no translation exists" |
| CAT-3 | provisional (no test) | none | Code: `isContentBlockKnown` tests object-ness. Server shape pinned by backend's contract test, not mine |
| REG-1 | provisional | mock | `discovery` content-block pair (read-only registers nothing) |
| REG-2 | provisional | mock | `write-lane` "sends late-rendering content sub-second rather than on the 3s poll tick" |
| REG-3 | provisional | mock | `write-lane` "sends what is still queued when the page goes away, with keepalive" |
| REG-4 | provisional | mock | `write-lane` TS-2/TS-4 asserts `keepalive` on every teardown request |
| REG-5 | provisional | mock | `write-lane` "does not re-send what the debounce already sent — visibilitychange also fires on a tab switch" |
| REG-6 | provisional | mock | `write-lane` "does not drop a miss recorded while a send is in flight" |
| REG-7 | provisional | mock | same test (asserts the first phrase is sent exactly once) |
| REG-8 | provisional | mock | `write-lane` "backs off instead of hammering a failing server, and keeps the batch" |
| REG-9 | provisional | mock | `grant-lane` REG-9 block — honours a lower server limit, keeps the default when absent, and chunks sends to it |
| REG-10 | provisional | mock | `write-lane` backoff test (failure ⇒ queued + backoff, one behaviour) |
| REG-11 | **not implemented** | none | No ellipsis warning. See gaps. |
| REG-12 | provisional (no test) | none | Primary mechanism is structural (`t()` treats a non-string value as known). A redundant 32-hex guard remains — see gaps |
| HINT-1 | implemented | mock | `discovery` — every assertion is on `page_url` only; no payload path exists |
| HINT-2 | n/a | n/a | Profile `server`. This SDK is `browser`/`all`. |
| HINT-3 | provisional | mock | `discovery` "names the MISS-time URL, not wherever the user navigated during the jitter" |
| HINT-4 | provisional | mock | `discovery` "reports a URL at most once per session" + "reports each URL separately" |
| HINT-5 | provisional | mock | `discovery` jitter is advanced explicitly in every lane test |
| HINT-6 | implemented | n/a (pure) | `discovery` `normalizeHintUrl` suite. `utm_*` prefix-matched per the server. Fragments preserved verbatim — conformant because the server now splits `normalize()` (verbatim, feeds dispatch) from `dedupKey()` (folds `#!/`→`#/`, suppression only), so preserving is correct rather than merely divergent. Credential-shaped params — in the query AND inside the fragment — decline the whole report rather than being stripped from it. Two contracts, deliberately different: NORMALIZATION stays identical across legs (divergence breaks dedup keys and renderer targets); the DECLINE PREDICATE is a union, where each leg may be stricter without coordination, because a passing URL is byte-identical whatever matched. See the credential-param gap under Gaps |
| HINT-7 | provisional | mock | `discovery` — no retry/backoff path exists in the lane |
| HINT-8 | provisional | mock | `discovery` "never reports during SSR" |
| HINT-9 | provisional | mock | `discovery` auto_discovery block — **includes the positive control**, per the pairing constraint |
| SSR-1 | provisional | mock | `write-lane` "'client' does not collect" + "'server' does" + "'auto' up to threshold" |
| SSR-2 | provisional | mock | `write-lane` TS-1. **Was a warning only until the TS-1..TS-11 review pass** — the degradation is now real |
| SSR-3 | provisional (no test) | none | Precondition documented; verified live once, not reproducible |
| BIND-1..6 | n/a | n/a | Profile `binding`. This is the core, not a binding. |
| GRANT-1 | implemented | mock | `grant-lane` "is attached when a grant is configured, and resolved per request" |
| GRANT-2 | implemented | mock | same test — asserts the provider is re-resolved, not cached |
| GRANT-3 | implemented | mock | `grant-lane` "issues a fresh authorization carrying the grant" |
| GRANT-4 | implemented | mock | `grant-lane` header assertions |
| OBS-1 | partial | none | Debug-level lines exist for every inert state (HINT-9, gate skips, absent `write_enabled`). Nothing is surfaced above debug. See gaps. |
| WIRE-1 | provisional | mock | `api-reachability` WIRE-1 block — `x-Authorization` asserted on every request, plus the ICU capability header |
| WIRE-2 | provisional | mock | `api` suite; 204 handled by status rather than content-type |
| WIRE-3 | implemented | n/a (pure) | `locale` WIRE-3 block + `api` wire assertion. Lowercase `xx-yy` internally and on the wire. **Deliberately supersedes main's BCP 47 casing** (operator ruling); CLAUDE.md invariant 1a and the CHANGELOG carry the reason and the migration note |
| WIRE-4 | provisional (no test) | none | Guarded (`window.location?.href`). No test asserts `t()` cannot throw |
| WIRE-5 | implemented | mock | `api-reachability` — redirect **observed** at the double, plus the ordering failure proven |
| CONF-1 | partial | — | Registration lanes assert catalog state; **hint lanes assert the outgoing payload**. See gaps. |
| CONF-2 | implemented | — | This file |
| CONF-3 | partial | — | `setWriteGrant` inertness is covered, but not by mutation. See gaps. |
| HINT-10 | implemented | n/a (pure) | `discovery` — exact set narrowed to `{sig, auth, otp, nonce}`; `normalizeParamName` strips `-`/`_` before matching; fragments gain `oauth`/`authcode`/`accesscode`; `code` matches only with an OAuth marker (`state`/`session_state`). Red-first: 14 of these fail against the parent commit |
| HINT-11 | implemented | n/a (pure) | `discovery` — `normalizeHintUrl` returns `null` for the whole report; both fragment shapes (`#/cb?code=&state=`, bare `#access_token=`); the no-`=` rule; the `?email` declines / `#contact-email` carries asymmetry. Seven shapes in `tests/fixtures/hint-url-fragment-reference.json`, iterated by the suite rather than restated |
| HINT-12 | implemented | mock | Upgraded from `partial` by moving the observation point. `discovery` "a declined URL crosses no boundary": for a matching URL **zero bytes reach the transport and nothing derived from it enters SDK-side state** — no `postDiscoveryHint` call, no `langsys:hinted:` entry, and no fragment of the path, host or param value anywhere in either. Mutation-checked twice: strip-and-send and no-gate-at-all both turn it red, and the positive control (a carried URL DOES cross both seams) stays green under both. The internal check-ordering remains unobservable and is no longer what the row rests on |
| ICU-1 | implemented | n/a (pure) | `interpolate` "missing select arguments fall back to `other`" — supplied branch, absent argument, unrecognised value all pinned |
| ICU-2 | implemented | n/a (pure) | same suite, "treats null and undefined as absent" |
| ICU-3 | implemented | n/a (pure) | same suite — `#` with no count renders `{argName}`; covered by the nested plural/select cases |
| ICU-4 | implemented | n/a (pure) | `interpolate` "debug notice for defaulted arguments" — names the argument and locale, **deduped per template+locale**, **silent unless `logger.debugEnabled`**, and fires for plural as well as select recoveries. Both directions asserted |
| CID-1 | **provisional** | none | Byte-identical hashing is anchored on `langsys-php/tests/fixtures/custom-id-reference.json`, and **this branch has never been executed against it** — CLAUDE.md requires running the *published tarball*, and none of this surface is published. Re-deriving the vectors here would prove nothing; both sides would share the mistake |
| CID-2 | implemented | n/a (pure) | `custom-id` — `generateCustomId` coalesces `category \|\| ''` on this branch. **This is NOT a cross-SDK divergence and produces no id change**: on `origin/main` and published 0.6.5 the function itself does not coalesce, but every internal caller already passes `''` (`iContentBlock.category` is non-optional; `translate.ts` destructures `const { category = '' }` at `:107`, `:135`, `:271`), so every SDK-generated id already matches PHP. The guard closes a third-party-caller hole in the *export*, not a behaviour gap. See the note below |
| CID-3 | implemented | mock | `translate` migration-fallback path — three historical id shapes tried on LOOKUP only, registration always uses the corrected id, so the legacy-keyed population can only shrink. Documented under "Historical ids" above |
| CID-4 | implemented | n/a (pure) | `content-block-identity` — one token per text node, arity is identity, comments skipped, attribute emission order pinned. Mutation-checked: adding `clone.normalize()` to `tokenizeElement` turns three of its tests red |

---

### CID-2 — enforcement differs, behaviour does not

The `category || ''` coalescing exists in the JS core only on
`feature/838_write_key_gating_reland`. `origin/main` and published `0.6.5`
compute `md5(JSON.stringify([category, tokens]))` with no coalescing.

**That is a difference in where the invariant is enforced, not in the ids
produced.** Every shipping caller already passes `''`: `iContentBlock.category`
is typed non-optional, and `translate.ts` destructures
`const { category = '' }` at `:107`, `:135` and `:271` before the value ever
reaches the hash. So published JS and PHP agree on every SDK-generated id, and
this branch changes no id at all — `'' || ''` is `''`, and a real category is
unchanged. There is no migration here.

The residual exposure is narrow and worth stating exactly: `generateCustomId`
is a public export, so a plain-JS or untyped third-party caller can pass
`undefined` directly, which serialises to `[null, …]` and yields an id no wire
path stores. This branch enforces the invariant at the reference implementation
rather than relying on every caller to hold it.

Recorded this way because the shorter version of this row — "enforced on this
branch, not on main" — reads as a live cross-SDK hash divergence, and that
reading reached the PHP lane before it was corrected. The claim is about a
function; the behaviour is a property of the function *plus its callers*, and
the two answers differ.

## Declared carve-out (GATE-3)

`Translations.ssrWriteEnabled` is a **process-level** cache of the write decision, which
GATE-3 forbids. It is permissible under the rule's exception clause and is declared here
rather than left silent:

- It is read **only** under SSR, and **only** when no write grant is configured.
- Without a grant, capability depends solely on the server's own IP, which is constant
  for the process — so it provably does not vary per session.
- Configuring a grant invalidates that proof, and the code refuses the SSR write lane
  entirely in that case (`shouldQueueForWrite`, fixed in the TS-1..TS-11 review pass — it previously
  refused to *send* but still *collected*, which rebuilt the leak the rule prevents).

---

## Historical ids — lookup-only, never re-keyed

Content registered before the 0.6.0 MD5 correction is stored under ids produced by a hash
that packed UTF-16 code units into byte lanes. Those ids are resolved by
`generateLegacyCustomId` on **lookup only** and are never registered under.

**There is no migration and there must not be one.** An earlier version of this file
recorded a hard "migration before SDK" ordering constraint, written on the assumption that
stored ids would be re-keyed. That assumption is dead, and the citation is a demonstrated
collision: `["UI",["xxxA"]]` and `["UI",["xxxŁ"]]` both hash to
`ba623bfd68d7c2b3fd3a63854bc5cd9d`, because the packing shift is unmasked and a code unit
above `0xFF` loses its high byte at `i % 4 === 3`. Reachable in ordinary content — `A`/`Ł`
in Polish, `e`/`ť` and `n`/`Ů` in Czech and Slovak. **A key space that is not injective
cannot be re-keyed**: where two blocks collided there is no correct target row, and a
partial unique index turns the guess into either a merge of two customers' distinct blocks
or an orphan.

So there is no ordering constraint, no orphaning risk, and no cost-of-delay. The
correction and its tolerating fallback shipped together in 0.6.0, which is the property
that matters — the two halves must never ship apart.

## Gaps, ranked by cost

1. **HINT-6 — resolved, retained for the record.** The SDK preserved hashbang fragments while
   the server canonicalised them, which would have dispatched the renderer to a route
   hashbang apps do not resolve. Resolved by the server splitting `normalize()` (verbatim,
   feeds dispatch) from `dedupKey()` (folds `#!/`→`#/`, suppression only) — neither leg
   conceded, and the two concerns that had been sharing one function were separated. Nothing
   outstanding.

2. **CONF-1 — the hint lanes assert on what the SDK sent.** They prove outgoing behaviour
   and say nothing about whether discovery received anything. This is the failure CONF-1
   exists to prevent, present in my own suite. Closing it needs a
   `discovery_render_targets` assertion or the shared fixture.
3. **A page whose URL carries a credential-shaped query param is never discovered.** Deliberate,
   and the cost is real: `?sig=`, `?otp=`, `?nonce=`, `?auth=`, anything containing `token`,
   `secret`, `password`, `apikey`, `authoriz`, `session`, `signature`, `credential`, `email`,
   `oauth`, `authcode` or `accesscode` (separator-insensitively), and `?code=` when an OAuth
   `state`/`session_state` rides with it. The same test applies to parameters carried in the
   FRAGMENT, which `searchParams` cannot see and which normalization deliberately preserves:
   `#/cb?code=x&state=y`, and the OAuth implicit flow `#access_token=…`, which has no `?` at
   all and is missed by any parser that only reads a `?` tail. A fragment segment without `=`
   is not a pair, so routes and anchors (`#/pricing`, `#section`, `#contact-email`) are
   unaffected. Such a page is not reported, so its content must be translated by hand.
   `normalizeHintUrl` returns `null` and logs the offending param name — in the page's own
   spelling, never its value — at debug level, so the developer gets an answer rather than
   silence.

   The decline predicate is a UNION across legs, not a synchronized list: it gates an
   unmodified URL, so a URL that passes is byte-identical whatever matched, and a stricter leg
   only declines more. That is why the server may carry checks this SDK lacks — the SDK build
   already deployed will never update, and the server is the only leg in front of it. The five
   fragment shapes are written down in `tests/fixtures/hint-url-fragment-reference.json` as
   documentation of intent rather than enforcement; a leg that misses one is contributing less,
   not failing a contract. The fixture also pins one asymmetry that looks like an
   inconsistency and is not: a valueless `?email` declines while `#contact-email` carries,
   because the `?` has already established parameter space and a fragment without one has not.
   Unifying it in either direction breaks one of the two.

   Worth recording, since it argues against the reflex that produced this bug: the whole-word
   treatment of `code`/`sig`/`auth` was already the right mechanism — structure over substring,
   the same insight the fragment rule needed — added during the original 838 work (2026-08-15) with
   `postcode`/`country_code`/`design`/`author` named as the cases it protected. The defect was
   never the mechanism. It was the membership: `key` and `code` were credentials in the abstract
   and routes in practice, and no amount of matching precision saves a list that names the wrong
   words.

   **For the record: stripping the param instead was inherited from the original
   implementation, not chosen.** It was wrong in two directions at once. Removing a param
   yields a URL that is no longer the page the miss came from, so the renderer visits a
   different page and registers what it finds there; and every page distinguished only by that
   param collapses onto one dedup key in both legs. Both failures are silent, with every status
   reporting success. Declining trades a discoverable page for an undiscovered one, which is at
   least consistent with what the customer observes.

   The list also carried `key` and `code` as whole words, which destroyed `?key=pricing` and
   `?code=US` — ordinary selectors on exactly the content-bearing pages discovery exists to
   find. Removed. Ranked here rather than lower because the residue is permanent and invisible
   from outside; ranked below CONF-1 because the class of affected pages is small and, unlike
   CONF-1, it is now stated rather than assumed.

4. **Everything graded `mock`.** Not fixable in this repo alone — it needs the shared
   stateful contract fixture (CONF-2, Open). Until then no row here can honestly claim
   better, however confident the behaviour.
5. **GATE-3, GATE-4, WIRE-4, CAT-3, REG-12, SSR-3 have no test at all.** I believe each is
   satisfied and can point at the code, which is exactly the standard of evidence CONF-1
   rejects. Low cost individually; the aggregate is that six rules rest on my reading.
   (WIRE-1 was the seventh and is now covered — the reviewer picked it as the cheapest and
   most load-bearing of the set.)
6. **REG-11 — no ellipsis warning.** Agreed as correct in the spec discussion, never
   implemented. Cost is catalog pollution plus double MT spend on truncated content,
   bounded by how often customers render truncated text through `t()`.
7. **OBS-1 — nothing is surfaced above debug level.** Deliberate for HINT-9 (the customer
   chose it), but an SDK that is inert because the server never returned `write_enabled`
   currently says so only at debug. Arguably that one warrants a warning, since nobody
   chose it.
8. **CONF-3 — runtime rules are not proven by mutation.** The `setWriteGrant` tests would
   have caught the original inert version, but I have not verified that by reverting the
   fix and watching them fail.

   One place this was done, recorded because the result was counter-intuitive: the logger's
   React-Native detection is covered by a pair of tests, and under mutation only the BROWSER
   one kills a latched implementation. The RN test passes either way — the test environment
   is `node`, so `window` is undefined at import and a latched check yields plain text for
   the wrong reason. The test that looks like it verifies the fix does not; the control does.
   A negative result is only evidence once the search has been shown able to return a
   positive, and which half of a pair carries that proof is not always the obvious one.
9. **REG-12 — a redundant 32-hex guard remains** in the queue path. The primary mechanism
   is already structural, so the guard can only ever be wrong (it would reject a
   legitimate 32-hex phrase). Removing it needs confirmation that a content-block id never
   reaches `t()`.

## Not applicable

`HINT-2` (server profile) and `BIND-1`..`BIND-6` (binding profile) — this package is the
core browser implementation, so neither profile applies. Recorded with a revision because
an `n/a` claim is a claim about the rule's Profiles line: a stale `implemented` row has a
test that will eventually fail, whereas a stale `n/a` row has nothing that can ever
contradict it.
