# Conformance — `langsys-js-typescript`

| | |
|---|---|
| **SDK** | `langsys-js-typescript` (browser reference implementation) |
| **Profiles** | `all`, `browser` |
| **specVersion** | 7 (read at 7.0.1) |
| **Spec revision read** | langsys `origin/main`, `docs/sdk-spec.mdx` blob `45cdddf8e9136a85143dc5a5169d59b3355d7dc1`, re-derived at write time with `git -C ~/Documents/dev/langsys2 ls-tree origin/main docs/sdk-spec.mdx`. Every rule profiled `all` or `browser` is audited against this blob |
| **SDK revision** | `feature/838_write_key_gating_reland`, cut from `origin/main` `2d7b11f` (v0.6.5) |
| **Suite** | 424 tests in 29 files, `npm test`, counted at the tip of this branch |

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

**All three shared fixtures are now vendored and asserted every run** —
`custom-id-reference.json` (13 rows), `tokenizer-reference.json` (17) and
`interpolation-reference.json` (19). Until this round the last two were checked only at
release time against the published tarball, which left ICU-1…5 and the tokenizer family
resting on evidence from inside this repo alone: tests I wrote against code I wrote,
unable to detect a mistake both sides share. That was the weakness CID-1 escaped first and
the reason it was recorded here as a follow-up rather than left to be noticed.

**On the vendored fixture.** `tests/fixtures/custom-id-reference.json` is a copy of
langsys-php's, at `8862841`. Vendored rather than fetched so the suite stays hermetic and a
fixture change arrives as a reviewable diff. The serialization is compared through
`canonicalContentBlockJson`, the same function `generateCustomId` hashes — never a second
expression written in the test. The PHP lane found four separate sites re-deriving their
serialization, one inside the assertion meant to be checking it; a parallel
reimplementation agrees with itself, and keeps agreeing after the real one moves.

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

**Commit-history correction.** Two commits on this branch misdescribe what they carry, and
the end state is correct while the history is not. `7e48652` — titled for the non-object
catalog guard — also contains the ENTIRE source implementation of the OBS-1 shared notice
and the REG-11 dedup: the module-scope latch, `noticeUnusableWriteCapability`, the
`applyWriteEnabled` call, `warnedEllipsis`, and the debug gate. `c1cf492`'s message says
"the notice moves to module scope in translations.ts" while its diff touches only
`langsys-app.ts` and tests. Earlier, `d3a8c8d` likewise carried the REG-11 warning and the
mint-site comment attributed to `d5028c1`.

Cause, since it is the same one all three times: the source edits were made across several
files before anything was committed, then staged whole-file — so the first commit to touch a
file swept up every unrelated change in it. Reconstructing this work from commit messages
would mislead; reconstructing it from diffs would not. Recorded rather than rewritten,
because the branch is pushed and a correction that stays visible is worth more than a
tidy history that hides having needed one. The self-check that prevents a third instance is
in CLAUDE.md's commit conventions.

**Known corner — CACHE-1 write-through does not compare locales.** An SSR handoff seeded for
locale A followed by a first scoping to locale B persists A's catalog under B's key. It heals
on the next `change()`, which fetches B and overwrites — unless that fetch fails, in which
case the stale entry survives to the next load. Not fixed: the seed carries no locale of its
own to compare against, so closing it properly means threading
`initialTranslationsLocale` into the cache layer, which is a wider change than the corner
justifies. Filed rather than left to be discovered.

**Spec moved; counts re-derived, not carried over.** The previous filing cited blob
`06ae105a`. At `45cdddf8` (history entry dated 2026-08-29) the rule total is unchanged at
**67**, and so is the set binding this SDK at **60** — but the distribution shifted:
`all` 44 → 40 and `browser` 16 → 20, which is **GRANT-1..4 re-profiled `all` → `browser`**
and nothing else. Those four still bind here either way, since `browser` is one of this
SDK's profiles, so no row was added, removed or re-graded by the move. The new server clause
attached to that family — a server SDK MUST NOT send `X-Write-Grant` — is addressed to a
profile this SDK is not.

**React Native adds no rows, and that is a finding rather than an omission.** It is listed in
the *membership* column of the **browser** profile with a footnote, not as a `Profiles:` value
on any rule — `grep -E '^\*\*Profiles:\*\*.*react'` over that blob returns nothing, and all
six mentions are prose. So there is no `react-native` profile to be unrowed against: an RN
consumer is bound by the `browser` rules already carried here. Said explicitly because
"a profile was added" and "rules were added" look the same from a distance, and only the
second would leave gaps.

**Coverage arithmetic**, so the counts reconcile rather than needing to be trusted. The spec
carries **67 rules**. **60 bind this SDK** (40 profiled `all`, 20 `browser`) and each has its
own row. The other seven are covered by two rows: `HINT-2` (profile `server`) keeps a row of
its own so the n/a stays visible as a claim about that rule's Profiles line, and `BIND-1..6`
share one combined row because a binding profile is n/a for the same single reason six times
over. So **62 physical rows covering 67 rules** — the row count and the rule count are
deliberately different numbers, and neither is the other.

Two kinds of n/a are kept apart. `HINT-2` and `BIND-1..6` are **profile-n/a**: the rule is
real and simply addressed to somebody else. That is not the same as a rule being
inapplicable to this architecture, which would need saying differently and does not currently
occur here.

**Grade vocabulary.** This file grades every row `implemented`, `partial`, `provisional`,
`corroborated (cross-implementation)` or `n/a`. The verification gate's reports use `met`
for what this file calls `implemented` — one grade, two words, and the mapping is stated
here once rather than by mixing both tokens into one column. `corroborated` is the only
grade that is not a synonym for anything the gate uses: see below for why it is kept apart.

**Evidence grades** follow CONF-2: `live` (real server), `contract` (stateful double),
`mock` (canned responses — does not meet the bar), `none`.

`corroborated (cross-implementation)` is a distinct status, not a synonym for
`implemented`, and the distinction is worth keeping. `implemented` means this SDK does
what the rule says, as judged here. `corroborated` means a second implementation, written
independently in another language, produces the same bytes — which excludes a whole class
of error that no amount of testing inside this repo can: the two sides sharing my mistake.
Six rows hold it: CID-1, CID-4 and ICU-1/2/3/5, backed by three vendored fixtures. Every `mock` and `none` row
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
| REG-11 | implemented | mock | `ellipsis-warning` — a phrase ending in `…` or `...` warns, naming it, and is **registered anyway**. The spec permits suppression only on a second signal (a longer catalog entry sharing the prefix); that half is NOT implemented, so nothing is ever skipped. Deliberate: a blanket skip has real false positives (`Loading…`) and silently refusing to register those would create a new silent failure, which is the class this surface exists to remove. Mid-string ellipses are not matched |
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
| BIND-1..6 | n/a | n/a | Profile `binding`. This is the core, not a binding — **profile-n/a, not architecture-n/a**. One contract runs the other way and the core owes it: **bindings may forward core methods UNBOUND** (Vue and Solid forward through a `Proxy` and assert identity, so `proxy.method()` runs with `this` set to the proxy), and **the core guarantees it declares no ECMAScript `#private` fields** — `#` access is keyed to the real instance and throws through a proxy, while TypeScript's `private` is erased and is fine (13 of those today). Adopting a single `#private` field is a breaking change for every Proxy binding, at runtime, in whichever method touched it. Pinned by `no-private-fields`, which scans `src/**/*.{ts,mts,cts,tsx}` and the package build, with its own positive control. **The dist half checks esbuild's lowering helpers, not just a literal `#`**: at our `es2021` target a private field is downlevelled to `__privateAdd`/`__privateGet` over a WeakMap, so a literal scan of `dist` finds nothing while the lowered form still throws through a Proxy — measured by loading the built artifact. A missing `dist` fails hard rather than skipping, and CI builds before it tests; previously it did the reverse, which made the dist assertion a permanent no-op there. TypeScript `private` members, which are erased and harmless, number **77** (42 fields + 35 methods, computed over `src/`) — an earlier note said 13, which was `langsys-app.ts` alone |
| GRANT-1 | implemented | mock | `grant-lane` "is attached when a grant is configured, and resolved per request" |
| GRANT-2 | implemented | mock | same test — asserts the provider is re-resolved, not cached |
| GRANT-3 | implemented | mock | `grant-lane` "issues a fresh authorization carrying the grant" |
| GRANT-4 | implemented | mock | `grant-lane` header assertions |
| OBS-1 | implemented | mock | `obs-notice` — a `write`/`ip_write` key resolving `write_enabled: false` warns once, ABOVE debug level, naming the key type and the remedy. Latched on the outcome, so a re-authorization that changes the answer speaks again and one that changes nothing stays quiet. Deliberately silent for a `read` key resolving read-only, which is correct behaviour and would otherwise make this the notice everyone silences. Mutation-checked: dropping the expected-to-write guard turns the read-key test red, dropping the latch turns the repeat test red |
| WIRE-1 | provisional | mock | `api-reachability` WIRE-1 block — `x-Authorization` asserted on every request, plus the ICU capability header |
| WIRE-2 | provisional | mock | `api` suite; 204 handled by status rather than content-type |
| WIRE-3 | implemented | n/a (pure) | `locale` WIRE-3 block + `api` wire assertion. Lowercase `xx-yy` internally and on the wire. **Deliberately supersedes main's BCP 47 casing** (operator ruling); CLAUDE.md invariant 1a and the CHANGELOG carry the reason and the migration note |
| WIRE-4 | provisional (no test) | none | Guarded (`window.location?.href`). No test asserts `t()` cannot throw |
| WIRE-5 | implemented | mock | `api-reachability` — redirect **observed** at the double, plus the ordering failure proven |
| CACHE-1 | implemented | mock | `cache-scope` — the catalog is keyed `langsys:translations:<projectid>:<locale>` and hydrated only once `init()` knows both, so a mismatch is a cache MISS rather than foreign content. Was keyed by neither: a page load restored whatever was stored and `t()` served it before anything could check whose it was. Mutation-checked twice — never-clear-on-scope-change turns the cross-project and cross-locale tests red; module-load hydration turns the superseded-key test red. Superseded keys are removed on first scoping |
| CONF-1 | partial | — | Registration lanes assert catalog state; **hint lanes assert the outgoing payload**. See gaps. |
| CONF-2 | implemented | — | This file |
| CONF-3 | partial | — | `setWriteGrant` inertness is covered, but not by mutation. See gaps. |
| HINT-10 | implemented | n/a (pure) | `discovery` — exact set narrowed to `{sig, auth, otp, nonce}`; `normalizeParamName` strips `-`/`_` before matching; fragments gain `oauth`/`authcode`/`accesscode`; `code` matches only with an OAuth marker (`state`/`session_state`). Red-first: 14 of these fail against the parent commit |
| HINT-11 | implemented | n/a (pure) | `discovery` — `normalizeHintUrl` returns `null` for the whole report; both fragment shapes (`#/cb?code=&state=`, bare `#access_token=`); the no-`=` rule; the `?email` declines / `#contact-email` carries asymmetry. Seven shapes in `tests/fixtures/hint-url-fragment-reference.json`, iterated by the suite rather than restated |
| HINT-12 | implemented | mock | Upgraded from `partial` by moving the observation point. `discovery` "a declined URL crosses no boundary": for a matching URL **zero bytes reach the transport and nothing derived from it enters SDK-side state** — no `postDiscoveryHint` call, no `langsys:hinted:` entry, and no fragment of the path, host or param value anywhere in either. Mutation-checked twice: strip-and-send and no-gate-at-all both turn it red, and the positive control (a carried URL DOES cross both seams) stays green under both. The internal check-ordering remains unobservable and is no longer what the row rests on |
| ICU-1 | **corroborated (cross-implementation)** | contract (shared fixture) | `interpolation-cross-impl` — all 19 rows of langsys-php's `interpolation-reference.json`, vendored @ `5fa4d48` blob `d369bd185ca2`, plus `interpolate` "missing select arguments fall back to `other`" |
| ICU-2 | **corroborated (cross-implementation)** | contract (shared fixture) | same fixture; plus `interpolate` "treats null and undefined as absent" |
| ICU-3 | **corroborated (cross-implementation)** | contract (shared fixture) | same fixture; plus the nested plural/select cases where `#` with no count renders `{argName}` |
| ICU-4 | implemented | n/a (pure) | `interpolate` "debug notice for defaulted arguments" — names the argument and locale, deduped per template+locale, silent unless `logger.debugEnabled`, fires for plural as well as select. Both directions asserted. NOT corroborated: a debug-only emission has no counterpart in the shared fixture, which asserts rendered output |
| ICU-5 | **corroborated (cross-implementation)** | contract (shared fixture) | `interpolation-cross-impl` (19 rows) plus `interpolate` "a recovered argument survives the format call" — five vectors, mutation-checked against restoring the argument node, which reproduces the PHP lane's live symptom. Conforming by remove-binding-sites, which the amended clause names explicitly |
| CID-1 | **corroborated (cross-implementation)** | contract (shared fixture) | `custom-id-cross-impl` — all 13 rows of langsys-php's `custom-id-reference.json`, vendored @ `8862841`. Per row: the vendored codepoints are checked FIRST (so a normalising editor can't mangle the file into agreement), then canonical string, then UTF-8 bytes vs `serialized_hex`, then `generateCustomId` vs `custom_id`. Two independently written serializers in different languages agreeing byte-for-byte, so implementation error is excluded and only spec-level error remains. Mutation-checked: escaping non-ASCII (the 2-flag equivalent) fails 10/13, swapping the envelope order fails 13/13 |
| CID-2 | implemented | n/a (pure) | `custom-id` — `generateCustomId` coalesces `category \|\| ''` on this branch. **This is NOT a cross-SDK divergence and produces no id change**: on `origin/main` and published 0.6.5 the function itself does not coalesce, but every internal caller already passes `''` (`iContentBlock.category` is non-optional; `translate.ts` destructures `const { category = '' }` at `:107`, `:135`, `:271`), so every SDK-generated id already matches PHP. The guard closes a third-party-caller hole in the *export*, not a behaviour gap. See the note below |
| CID-3 | implemented | mock | `translate` migration-fallback path — three historical id shapes tried on LOOKUP only, registration always uses the corrected id, so the legacy-keyed population can only shrink. Documented under "Historical ids" above |
| CID-4 | **corroborated (cross-implementation)** | contract (shared fixture) | `tokenizer-cross-impl` — all 17 rows of `tokenizer-reference.json`, vendored @ `5fa4d48` blob `a8632b462c52`, asserting the token ARRAY (arity and order are the identity) and the id that follows from it; plus `content-block-identity`, mutation-checked — adding `clone.normalize()` to `tokenizeElement` turns three of its tests red |

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

## New spec families — read at the pushed blob

Read at langsys `1493dea0`, `docs/sdk-spec.mdx` blob
`318b594173c7470fbcfcf1eaec19ff9e62bec517` — **verified reachable and matching before use**
(`git ls-tree 1493dea0 docs/sdk-spec.mdx`), not taken from the report. Supersedes `593abecd`
read earlier this round, which itself superseded the `57c8a498` draft carried as
reported-and-unread. Three blobs in one round: re-derive, never carry forward.

Carrying that one as unread rather than asserting it turned out to matter. Langsys has since
said they once sent the Reviewer a blob hash they had not derived, and were caught. A hash
relayed in prose is a claim; `ls-tree` is the check.

All four previously-unconfirmed mappings were correct, and are now confirmed **against the
bodies** rather than against the author's summary of them. TOK-1..5 and MARK-1/2 are profiled
`all`, so they bind this SDK.

| Rule | Status | Evidence |
|---|---|---|
| SRV-4 (synchronous seed) | **core half implemented; the Profiles line now includes this SDK** | `seed-catalog` — `t()` resolves on the line after `seedCatalog()`; returns `undefined`, not a promise; an actual deferral (`await Promise.resolve()`) reds 4 of 9; a bare `async` keyword reds only 1 — the return-type assertion — which is why that assertion exists. The body states the split this lane reported: *"Exposing the synchronous seed is the core's half and is provable there."* At `1493dea0` the Profiles line reads `server; **browser core** for the synchronous seed it exposes; and a binding for any render…` — corrected after this lane reported that the body assigned the core a half its profile line denied it. The binding half (calling the seed before hydration, and the hydration-mismatch control) remains not ours |
| SRV-1..3, SRV-5 | profile-n/a | All five SRV rules are profiled `server; and a binding…`. Serving translated HTML is the server's half of the hand-off; none of them bind a browser core by their Profiles lines |
| MARK-1 (content-block stamp) | implemented | `translate` — the stamp is compared against an id **re-derived by running the tokenizer over the same subtree**, not read back from the attribute just written, which is what MARK-1's test asks for and would otherwise prove only that a write happened. Mutations: dropping the stamp and stamping a constant each red four |
| MARK-2 (phrase stamp, both spellings read) | implemented | `content-block-identity` — behavioural and cross-module: the attribute `Phrase` exports is the one the tokenizer skips on, and PHP's spelling is accepted alongside it |
| TOK-3 (27 attributes, order normative) | implemented | `tokenizer-convergence` + `pure-subpath` — the 27 verified against `langsys-php/src/Html/HtmlParser.php` directly, appended never inserted, with a case asserting list order beats document order. Langsys's point is the sharp one: the same set in a different order agrees on every single-attribute element and diverges only where nobody looks |
| TOK-1 (skip script/style/template **and noscript**) | implemented | Re-rowed against blob `b657b490` (langsys `483f98fb`), verified with `ls-tree`. TOK-1 REVERSED on `noscript` and now excludes it. `tokenizer-convergence` asserts exclusion under BOTH parser models — the markup shape happy-dom and libxml2 give, and the raw-text shape Chromium and parse5 give — plus an ordinary-markup control, which the rule names as the whole test because over-excluding fails identically from outside. Red-first: both noscript assertions failed against the previous list. `<template>` remains named as intent and is not a vector |
| TOK-2 (U+00A0 collapses) | implemented, free in this runtime | `tokenizer-convergence` — satisfied with no code: JavaScript's `\s` already matches U+00A0. Pinned anyway, because the rule now warns that a hand-written character class would silently drop it. Finding credited to this lane in the rule body |
| TOK-4 (attribute values collapse as text does) | implemented, text unread | `tokenizer-convergence` — one normaliser shared by both paths, so "same content, same id" holds by construction. Before: `<img alt="A long\n  description">` kept its newlines while the same sentence in a `<p>` collapsed |
| TOK-5 (`{name}` with `%name%` accepted) | implemented, text unread | `tokenizer-convergence` + `interpolate` — `%name%` now resolves at RENDER, conditional on the key being supplied, so prose containing percent signs is untouched |
| Side-effect-free identity subpath | implemented | `pure-subpath` — bare Node under a trapping `globalThis`, import and every call clean for ESM and CJS, main entry as the positive control, export list pinned, and `/pure` proven to share function identity with the DOM path rather than re-implementing it. No rule id was reported for this; it may be unruled |

SSR-1..3 keep their ids and bodies; Langsys reports only their families-table row moved from
`server (JS)` to `browser`, which does not change what this SDK owes.

### A control this SDK structurally cannot carry — now in the spec

SRV-4's test as specified pairs "seeded renders the translation" with "unseeded produces a
hydration-mismatch warning". The second half is framework-level: the core has no renderer to
mismatch, so it cannot emit that warning. The core-level equivalent is in place — `t()`
demonstrably returns source text with no seed, and the seed is what changes it on the same
phrase — and the warning half belongs to the bindings. Flagged rather than quietly treated as
satisfied, because a core reporting SRV-4 green without it would be claiming a binding's
evidence as its own.

Langsys adopted this into SRV-4's body — a core records the half it holds and names the half
it does not. Worth noting which direction that went: filing the row as *unsatisfiable here*
rather than green is what surfaced the gap in the rule. A green row would have hidden it, and
the rule would have stayed unfulfillable by any core.

### SRV-4's Profiles line excluded the core it obligated — now fixed

Reading the pushed text rather than the author's summary turned up the opposite of the bug the
fleet had already named. The body said the core holds a provable half; the Profiles line said
`server; and a binding…`, no core of any profile. A core reading only the profile would row it
`n/a` and be correct to.

That is the **inverse of the unfalsifiable-profile class**: not a rule that cannot fail for a
profile it lists, but a rule obligating a profile it does not list. The Profiles section's own
operational test settles it — a core CAN fail SRV-4, by shipping a seed that must be awaited —
so the profile was wrong, not the body. Corrected at `1493dea0`; the rule body now records the
class in both directions, since the fleet has hit it each way.

### TOK-1's noscript half: reversed, and my framing of it was half wrong

`tokenizer-convergence` covers noscript under a scripting-DISABLED parser, which is what
happy-dom and PHP's server-side parser both give. The HTML Standard makes a noscript body RAW
TEXT when scripting is ENABLED, so a real browser produces one text node of literal markup.
Measured against our own tokenizer with that node shape constructed by hand — happy-dom cannot
produce it, so this is the shape, not a browser measurement:

```
scripting off / PHP   ["Keep", "Enable JavaScript"]
scripting on  / browser   ["Keep", "<p>Enable JavaScript</p>"]
```

**The browser half was right and the server half was an assumption.** JS Server measured real
Chromium (one raw-text token, as predicted) and then parse5 — which defaults to
`scriptingEnabled: true` and produces the SAME raw-text token. So a JS server AGREES with a
browser, and the JS-to-JS hand-off was never broken. I had reported it as a server-versus-browser
divergence; the real axis is the parser's scripting flag, which puts the whole JS family on one
side and PHP's libxml2 on the other.

Worse for my original report: **happy-dom and jsdom sit on PHP's side**, so the test environment
is the odd one out. A lane measuring there reproduces a browser-versus-server fork that does not
exist. My measurement was sound; my attribution of the two sides was not, and it took another
lane running a real browser to show it.

TOK-1 then reversed and now EXCLUDES `noscript` — the obvious reading (its text shows to a
visitor with scripting off) does not survive asking who could translate it: with scripting off a
browser SDK is not running. Excluding it is also what makes the two parser models agree, which
removes the divergence rather than documenting it. Implemented and pinned under both models.

### The shared tokenizer fixture contradicted itself

`tokenizer-reference.json` carries a row named **"script and style contents are never
harvested"** whose expected tokens are `["Keep", "var a=1;", ".a{}"]`. The name states the
intent; the data encodes the opposite. Both SDKs matched the data, so both harvested CSS and
JavaScript as translatable phrases and sent them for machine translation — while the row's
name said they did not. The fixture was corroborating the bug it was named for.

Found by implementing the convergence: the fix turned that row red. The vendored copy is
never edited, so the corrected expectation lives in `tokenizer-cross-impl` as a named
override, and a second test asserts each override still *disagrees* with the fixture — so
when the PHP lane re-derives the row, the override fails and has to be deleted rather than
quietly outliving its reason.

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
6. **REG-11 — the permitted suppression half is not implemented.** The warning is in and nothing is skipped, which conforms. The optional second signal — suppress when a longer catalog entry shares the prefix — would need a prefix scan of the catalog on every miss, and buys only the pollution case the warning already surfaces. Recorded as a deliberate omission rather than a gap.
7. **OBS-1's notice covers capability, not every inert state.** The write-capability warning is now above debug on both channels. HINT-9's reporting-disabled case stays debug-only deliberately — the customer chose that setting, so it is a configuration, not a fault.
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
