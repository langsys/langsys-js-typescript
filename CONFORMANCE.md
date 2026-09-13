# Conformance — `langsys-js-typescript`

| | |
|---|---|
| **SDK** | `langsys-js-typescript` (browser reference implementation) |
| **Profiles** | all, browser |
| **specVersion** | 8.0.1 (a correction to v8, not a new release) |
| **Spec revision read** | langsys2 5cff03a1…, docs/sdk-spec.mdx blob 5c5c0723f88fb8e6b13f58876c7adca8b6b35691 (specVersion 8.0.1, unpublished, the committed target for the 8.0.1 push). Re-derived with `git -C ~/Documents/dev/langsys2 ls-tree 5cff03a1 docs/sdk-spec.mdx` at this write and checked by `npm run verify:spec`, which also fails if the vector file cites a different blob. Every rule id is counted by `npm run tally:conformance`. |
| **SDK revision** | `feature/838_write_key_gating_reland`, cut from `origin/main` `2d7b11f` (v0.6.5) |
| **Suite** | 801 tests in 45 files, `npm test`, counted at the tip of this branch |

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
`interpolation-reference.json` (19 then, 23 since its no-params rows were added). Until this round the last two were checked only at
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

**Spec moved; counts re-derived, not carried over.** *(History. The live counts are in
Coverage arithmetic above — 79 rules, 68 binding. The figures in this paragraph were correct
when written and are kept because the reasoning still is.)* An earlier filing cited blob
`06ae105a`. At `45cdddf8` the rule total was then unchanged at 67, as was the set binding this
SDK at 60 — but the distribution had shifted: `all` 44 → 40 and `browser` 16 → 20, which was
**GRANT-1..4 re-profiled `all` → `browser`** and nothing else. Those four still bind here either way, since `browser` is one of this
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

**Coverage arithmetic**, derived by `npm run tally:conformance` against the cited blob rather
than typed. The spec carries **79 rules**, and **68 bind this SDK**: 47 profiled `all`, 20
`browser`, plus SRV-4, whose Profiles line names the browser core for the synchronous seed it
exposes. The other eleven are addressed to other profiles: HINT-2 (`server`), SRV-1, 2, 3 and 5
(`server; and a binding …`), and BIND-1 to BIND-6 (`binding`).

**79 rows, one rule id each.** Earlier revisions of this file used 71 physical rows, with
BIND-1..6 and four SRV rules sharing combined rows and descriptive suffixes on some rule cells.
The canonical conformance format, which the Reviewer measures the same way across every SDK,
allows exactly one id per row and no ranges, so the combined rows are expanded. The script
fails on a missing, duplicated, ranged or compound id.

**Grade vocabulary.** `implemented`, `provisional`, `partial`, `not implemented`,
`held (strip ruling)`, `n/a (profile: …)` and `n/a (architecture: …)`, plus `delegated`
(bindings only) and `waived`, neither used here. The two n/a grades stay distinct: a profile n/a
says a real rule is addressed to someone else, an architecture n/a says it cannot apply here and
what would make it live. This file has no architecture n/a rows.

**Tier describes the evidence for the property the rule governs, not whether a double appears
in the test.** `live`, `contract` and `mock` apply only where that property depends on what the
API answers: acceptance, refusal, or state across calls. Everything else is `n/a (pure)`:
in-process behaviour, cross-implementation identity fixtures (reference vectors, never
`contract`), meta-rules discharged by this document and its checker, artifact inspection with a
positive control, and isolation or scoping properties a stateful fixture could neither prove nor
disprove. An `implemented` row needs `live`, `contract` or `n/a (pure)`. A `provisional` row
needs `mock` and names what it waits on. `partial`, `not implemented` and the n/a grades carry `-`.

**Two grades from earlier revisions are retired.** `corroborated (cross-implementation)` was a
status here, meaning a second implementation written in another language produces the same
bytes. The distinction is real and is kept, as evidence rather than status: those rows now read
`implemented`, tier `n/a (pure)`, "cross-implementation fixture". And `provisional (no test)` is
gone, because behaviour without a test is `partial`, not provisional.

**Twelve rows were misgraded, and the checker is why that will not recur.** GATE-8, REG-11,
HINT-1, GRANT-1 to GRANT-4, OBS-1, WIRE-5, CACHE-1, HINT-12 and CID-3 were graded `implemented`
while recording a `mock` tier, which CONF-2's status definition does not allow. Each was
regraded on the rule above. Where the governed property depends on the API's answer the row is
now `provisional` (GATE-8, OBS-1). Where it does not, the tier was wrong rather than the status
(REG-11, HINT-1, GRANT-2, GRANT-3, GRANT-4, WIRE-5, CACHE-1, HINT-12). Two were not implemented as
claimed: GRANT-1's documentation clause has no test, and CID-3's named test does not exist. The
tally script checks status against tier, not status alone, which is the check that would have
caught all twelve.

Grade summary over the 79 rows, printed by `npm run tally:conformance` at this write:

```
  40  implemented
  13  provisional
  12  partial
  11  n/a (profile)
  2   not implemented
  1   held (strip ruling)
  implemented, by tier:
    40  n/a (pure)
  provisional, by what it waits on:
    13  conf-2 shared contract fixture
```

---

## Status

| Rule | Status | Tier | Evidence |
|---|---|---|---|
| GATE-1 | provisional | mock | `ssr-strategy-isolation` grant case, `discovery` mutual-exclusion, `grant-lane` applies the re-authorized capability. The property is the server-computed write_enabled, and these doubles cannot refuse. The IP arm was verified live once and is not reproducible. Waits on: conf-2 shared contract fixture. |
| GATE-2 | provisional | mock | `grant-lane` "flushes what was held once capability resolves true". Depends on the capability the server returns. Waits on: conf-2 shared contract fixture. |
| GATE-3 | implemented | n/a (pure) | `write-decision-persistence`: recording the decision in both directions writes nothing that carries it to an injected recording storage, with a positive control that the same recorder and detector catch a boolean that IS persisted; under SSR the decision is not recorded at all. The SSR process-level value is the declared carve-out below. Mutation: in `src/stores.ts`, back `writeEnabled` with `persist('langsys:writeEnabled', undefined)`; 1 test goes red. |
| GATE-4 | implemented | n/a (pure) | `write-decision-cache`, one describe per endpoint row of the rule. Each records every storage write while the response is handled, with two positive controls: the catalog reached storage, and the decision was read. `/translations`: the envelope flag is read and not cached, and a flag misplaced inside `data` is dropped rather than cached. `/authorize-project`: `init` reads the flag from inside `data` and writes the body to no storage. Mutations: cache the envelope flag beside the catalog body in `getTranslations` (1 red); keep a scalar member of `data` instead of deleting it (1 red); persist the authorize body in `LangsysApp.init` (1 red). |
| GATE-5 | provisional | mock | `discovery` "a write-enabled session registers the block and does NOT report" (cache written only after confirmed acceptance). Acceptance is the property, and proving it needs a double that can refuse plus a second read. Waits on: conf-2 shared contract fixture. |
| GATE-6 | provisional | mock | `discovery` "never reports from a write-enabled session", plus the content-block pair. Depends on write_enabled from the server; asserted on reports captured by a mocked sender (see CONF-1). Waits on: conf-2 shared contract fixture. |
| GATE-7 | provisional | mock | `discovery` "reports a page whose unregistered content is a content block, not a t() miss", both directions. Routing follows the server capability answer; asserted on captured reports (see CONF-1). Waits on: conf-2 shared contract fixture. |
| GATE-8 | provisional | mock | `grant-lane` GATE-8 block (write/read fallback, `ip_write` refused, re-evaluated per response, report lane off from the same condition, permissive policy cannot re-enable it) + `discovery` constraint-3 block The property is how the SDK reads a payload that omits write_enabled, which is an API answer. Previously graded implemented while recording this same mock tier, which CONF-2 does not allow. Waits on: conf-2 shared contract fixture. |
| CAT-1 | implemented | n/a (pure) | `translations` lookup suite + `write-lane` TS-3 (prototype-named phrase) Mutation: not yet recorded (CONF-3). |
| CAT-2 | implemented | n/a (pure) | `translations` "returns the phrase as fallback when no translation exists" Mutation: not yet recorded (CONF-3). |
| CAT-3 | implemented | n/a (pure) | `catalog-block-shape`: a block whose phrases are all null is known, and a null or a string under the id is not. A write-enabled `Translate` over a known but untranslated block POSTs nothing, with a control that the same session does register a block the catalog lacks. Mutation: in `isContentBlockKnown`, require at least one string phrase; 2 tests go red. |
| REG-1 | provisional | mock | `discovery` content-block pair: a read-only session registers nothing, asserted by a spy seeing no call (see CONF-1). Depends on write_enabled from the server. Waits on: conf-2 shared contract fixture. |
| REG-2 | implemented | n/a (pure) | `write-lane` "sends late-rendering content sub-second rather than on the 3s poll tick". The property is when and what the SDK sends, observable without the server answer. Mutation: not yet recorded (CONF-3). |
| REG-3 | implemented | n/a (pure) | `write-lane` "sends what is still queued when the page goes away, with keepalive". Proven on the browser teardown path (visibilitychange, pagehide). A host without `document` installs no teardown flush, so React Native reaches none; a core seam is proposed and routed to the operator. Mutation: not yet recorded (CONF-3). |
| REG-4 | implemented | n/a (pure) | `write-lane` TS-2/TS-4 asserts keepalive on every teardown request. Mutation: not yet recorded (CONF-3). |
| REG-5 | implemented | n/a (pure) | `write-lane` "does not re-send what the debounce already sent". The property is when and what the SDK sends, observable without the server answer. Mutation: not yet recorded (CONF-3). |
| REG-6 | implemented | n/a (pure) | `write-lane` "does not drop a miss recorded while a send is in flight". The property is when and what the SDK sends, observable without the server answer. Mutation: not yet recorded (CONF-3). |
| REG-7 | implemented | n/a (pure) | `write-lane` "does not drop a miss recorded while a send is in flight", asserting the first phrase is sent exactly once. Mutation: not yet recorded (CONF-3). |
| REG-8 | provisional | mock | `write-lane` "backs off instead of hammering a failing server, and keeps the batch". Depends on the server refusing. Waits on: conf-2 shared contract fixture. |
| REG-9 | provisional | mock | `grant-lane` REG-9 block: honours a lower server limit, keeps the default when it is absent, and chunks sends to it. The limit is an API answer. Waits on: conf-2 shared contract fixture. |
| REG-10 | provisional | mock | `write-lane` backoff test: a failure means queued plus backoff, one behaviour. Depends on the server refusing. Waits on: conf-2 shared contract fixture. |
| REG-11 | implemented | n/a (pure) | `ellipsis-warning` — a phrase ending in `…` or `...` warns, naming it, and is **registered anyway**. The spec permits suppression only on a second signal (a longer catalog entry sharing the prefix); that half is NOT implemented, so nothing is ever skipped. Deliberate: a blanket skip has real false positives (`Loading…`) and silently refusing to register those would create a new silent failure, which is the class this surface exists to remove. Mid-string ellipses are not matched The warning is local and needs no server. Suppression on a second signal is permitted, not required, and is not implemented, which conforms. Mutation: not yet recorded (CONF-3). |
| REG-12 | implemented | n/a (pure) | `structural-block-detection`. A phrase shaped like a 32-hex id and absent from the catalog is queued and registered, and a hash-shaped phrase with a stored translation renders it. Presence and structure agree on both paths: text colliding with a stored block id is known to `t()` (source text, nothing queued or sent), and a token queued before the block arrived is dropped by the flush dedup. The 32-hex guard in `missingToken` is removed: `t()` is its only caller, custom ids go only to `lookupContent`, and no binding or JS Server passes one to `t()`. Mutations, in an isolated copy: restore the guard (2 red); decide known in `t()` by a string or null value instead of presence (1 red); dedup the flush on a string value instead of presence (1 red). |
| HINT-1 | implemented | n/a (pure) | `discovery` — every assertion is on `page_url` only; no payload path exists The property is the shape of the report the SDK builds. Mutation: not yet recorded (CONF-3). |
| HINT-2 | n/a (profile: server) | - | Profile `server`. This SDK claims all and browser. |
| HINT-3 | implemented | n/a (pure) | `discovery` "names the MISS-time URL, not wherever the user navigated during the jitter". Mutation: not yet recorded (CONF-3). |
| HINT-4 | implemented | n/a (pure) | `discovery` "reports a URL at most once per session" and "reports each URL separately". Mutation: not yet recorded (CONF-3). |
| HINT-5 | implemented | n/a (pure) | `discovery` "HINT-5". With `Math.random` fixed at 0, nothing sends before 5s and it sends at 5s; fixed at its maximum, it sends by 30s; a mid-range draw sends mid-window; no catalog fetch precedes the send. Mutations: a zero delay reds 3; widening the window to 60s reds 6, among them both upper-bound tests; fetching the catalog in `flushHint` reds 1. |
| HINT-6 | implemented | n/a (pure) | `discovery` `normalizeHintUrl` suite. `utm_*` prefix-matched per the server. Fragments preserved verbatim — conformant because the server now splits `normalize()` (verbatim, feeds dispatch) from `dedupKey()` (folds `#!/`→`#/`, suppression only), so preserving is correct rather than merely divergent. Credential-shaped params — in the query AND inside the fragment — decline the whole report rather than being stripped from it. Two contracts, deliberately different: NORMALIZATION stays identical across legs (divergence breaks dedup keys and renderer targets); the DECLINE PREDICATE is a union, where each leg may be stricter without coordination, because a passing URL is byte-identical whatever matched. See the credential-param gap under Gaps Mutation: not yet recorded (CONF-3). |
| HINT-7 | implemented | n/a (pure) | `discovery` "HINT-7". A rejected send is not retried across ten further minutes. A failed report leaves no state, so a later miss on the same page sends nothing, with a control that a different page still reports. A 429 disables reporting for the rest of the session. The tier describes the governing property, the absence of retry and backoff, which is in-process; the rate-limit clause is driven by a 429 double. Mutations: re-arm the send 60s after a rejection (1 red); mark the page reported only on success (1 red); remove `hintsDisabledForSession = true` (1 red). |
| HINT-8 | implemented | n/a (pure) | `discovery` "never reports during SSR". Mutation: not yet recorded (CONF-3). |
| HINT-9 | provisional | mock | `discovery` auto_discovery block, including its positive control. The policy is what the server returns; asserted on captured reports (see CONF-1). Waits on: conf-2 shared contract fixture. |
| HINT-10 | implemented | n/a (pure) | `discovery` — exact set narrowed to `{sig, auth, otp, nonce}`; `normalizeParamName` strips `-`/`_` before matching; fragments gain `oauth`/`authcode`/`accesscode`; `code` matches only with an OAuth marker (`state`/`session_state`). Red-first: 14 of these fail against the parent commit |
| HINT-11 | implemented | n/a (pure) | `discovery` — `normalizeHintUrl` returns `null` for the whole report; both fragment shapes (`#/cb?code=&state=`, bare `#access_token=`); the no-`=` rule; the `?email` declines / `#contact-email` carries asymmetry. Seven shapes in `tests/fixtures/hint-url-fragment-reference.json`, iterated by the suite rather than restated Mutation: not yet recorded (CONF-3). |
| HINT-12 | implemented | n/a (pure) | Upgraded from `partial` by moving the observation point. `discovery` "a declined URL crosses no boundary": for a matching URL **zero bytes reach the transport and nothing derived from it enters SDK-side state** — no `postDiscoveryHint` call, no `langsys:hinted:` entry, and no fragment of the path, host or param value anywhere in either. Mutation-checked twice: strip-and-send and no-gate-at-all both turn it red, and the positive control (a carried URL DOES cross both seams) stays green under both. The internal check-ordering remains unobservable and is no longer what the row rests on Cross-leg reference vectors in `tests/fixtures/hint-url-fragment-reference.json`. |
| ICU-1 | implemented | n/a (pure) | Cross-implementation fixture: `interpolation-cross-impl`, all 23 rows of langsys-php's `interpolation-reference.json`, vendored @ `4c51eae` blob `725e7908ffac` and each asserted through both `interpolate` and `t()`, plus `interpolate` "missing select arguments fall back to `other`". The fixture cannot reach the call paths, since every row supplies params, and they returned the raw source until the JS Server lane executed one. `icu-no-params` shows that with no params `t()` in both overloads, a catalog hit, and `<Translate>` (a single token, a multi-token block at the base locale, an attribute) render `other`; that supplied params still choose, including on the single-token path that used to interpolate `t()`'s result a second time; and that plain text with braces is left as written. Mutations, in an isolated copy: `t()` returns early without params (4 red); `applyParams` returns early (2 red); the base-locale walk skips ICU blocks again (2 red); the single-token path applies params to `t()`'s result (1 red); revert `translations.ts` and `translate.ts` (7 red). The fixture's no-params rows omit the argument where a row omits `params`: requiring `interpolate`'s params again reds those two rows on `interpolate`, and restoring `t()`'s early return reds the same two on `t()`. |
| ICU-2 | implemented | n/a (pure) | Cross-implementation fixture: `interpolation-cross-impl`, all 23 rows of langsys-php `interpolation-reference.json`. same fixture; plus `interpolate` "treats null and undefined as absent" Mutation: not yet recorded (CONF-3). |
| ICU-3 | implemented | n/a (pure) | Cross-implementation fixture: `interpolation-cross-impl`, all 23 rows of langsys-php `interpolation-reference.json`, plus the nested plural/select cases where `#` with no count renders `{argName}`. On the call paths, `icu-no-params` shows `t()` rendering `{count} items` for a plural given no count, and a `<Translate>` block at the base locale doing the same. Mutations: `t()` returning early without params reds the `t()` case; `applyParams` returning early reds the block case. |
| ICU-4 | implemented | n/a (pure) | `interpolate` "debug notice for defaulted arguments" — names the argument and locale, deduped per template+locale, silent unless `logger.debugEnabled`, fires for plural as well as select. Both directions asserted. NOT corroborated: a debug-only emission has no counterpart in the shared fixture, which asserts rendered output Mutation: not yet recorded (CONF-3). |
| ICU-5 | implemented | n/a (pure) | Cross-implementation fixture. `interpolation-cross-impl` (23 rows) plus `interpolate` "a recovered argument survives the format call" — five vectors, mutation-checked against restoring the argument node, which reproduces the PHP lane's live symptom. Conforming by remove-binding-sites, which the amended clause names explicitly |
| CID-1 | implemented | n/a (pure) | Cross-implementation fixture. `custom-id-cross-impl` — all 13 rows of langsys-php's `custom-id-reference.json`, vendored @ `8862841`. Per row: the vendored codepoints are checked FIRST (so a normalising editor can't mangle the file into agreement), then canonical string, then UTF-8 bytes vs `serialized_hex`, then `generateCustomId` vs `custom_id`. Two independently written serializers in different languages agreeing byte-for-byte, so implementation error is excluded and only spec-level error remains. Mutation-checked: escaping non-ASCII (the 2-flag equivalent) fails 10/13, swapping the envelope order fails 13/13 Token derivation feeding the hash is covered by `tokenizer-cross-impl` (all 17 rows of `tokenizer-reference.json`) and `content-block-identity`, where adding `clone.normalize()` to `tokenizeElement` reds three; that evidence was previously filed under CID-4. |
| CID-2 | implemented | n/a (pure) | `custom-id` — `generateCustomId` coalesces `category \|\| ''` on this branch. **This is NOT a cross-SDK divergence and produces no id change**: on `origin/main` and published 0.6.5 the function itself does not coalesce, but every internal caller already passes `''` (`iContentBlock.category` is non-optional; `translate.ts` destructures `const { category = '' }` at `:107`, `:135`, `:271`), so every SDK-generated id already matches PHP. The guard closes a third-party-caller hole in the *export*, not a behaviour gap. See the note below Mutation: not yet recorded (CONF-3). |
| CID-3 | implemented | n/a (pure) | Cross-implementation identity fixture. `legacy-id-tolerance` vendors langsys-python's 20-row `legacy-custom-id-reference.json` at blob dc5556466dc54fe82e81ac9fdbf4549b2b76e7ce, checked every run. Per row it shows the code-unit id and the PHP pipe-join id are tried, and that a block seeded under each resolves through the real lookup: the current id first, then `historicalCustomIds`. Uncategorised slots cover `''`, `'__uncategorized__'` and `null`, the union of the Python and PHP lists. Registration still uses only the CID-1 form. On an ASCII row the code-unit id equals the current id and resolves there. Mutation: hash UTF-8 bytes instead of UTF-16 code units in `historicalCustomIds`; exactly the 13 non-ASCII rows (3 to 14, and 16) go red, 26 tests. |
| CID-4 | implemented | n/a (pure) | `legacy-id-tolerance` "CID-4". A historical match is attached only when the stored block's phrases equal the current tokens as a set, compared after the normalisation hashing uses (`blockContentMatches`, as langsys-python's `_block_matches`). The fixture's code-unit collision pair (rows 15 and 16) is declined, with a control that the block the id was written for resolves; a pipe-join id holding different phrases is declined; on the render path a colliding historical id is not attached and the block keeps its own current id. Mutation: attach on presence, replacing the content check in `resolveHistoricalBlockId` with `if (false)`; 3 tests go red. |
| TOK-1 | implemented | n/a (pure) | **Now five: `['script','style','template','noscript','math']`.** `<math>` was the 8.0.1 addition and this SDK shipped v8 without it — measured, `<p>Area <math><mi>x</mi><mo>+</mo><mn>2</mn></math> units</p>` gave `['Area','x','+','2','units']`, registering a bare variable and an OPERATOR as translatable phrases and sending them for machine translation. Not merely wasteful like harvesting CSS: translating an operator corrupts the expression rather than mislocalising a sentence. Fixed with the operator's go, the `custom_id` shift for blocks containing `<math>` accepted on a measured-negligible production blast radius. `tokenizer-convergence` carries TOK-1's own specified shape, now FOUR excluded elements plus the surviving ordinary copy in ONE document with exactly one phrase produced — the form that cannot be satisfied by an implementation which tokenizes nothing, which is why the surviving control is load-bearing. **`<svg>` is conformant on all three of 8.0.1's behavioural clauses, each measured:** its `<text>` IS harvested; an inline svg never costs its parent block the parent's own direct text (`<p>Click <svg><text>go</text><path/></svg> to continue</p>` → `['Click','go','to continue']`, order included); and translation replaces the text NODE in place so `<path d>` geometry survives a render (`translate`). That last clause needs a render, not a token comparison — a writer setting `textContent` on the nearest element produces correct tokens and a destroyed drawing, the same defect class as the single-token `innerText` path. Mutants, both directions: removing `math` reds **5**, adding `svg` reds **5** — the second being a pin on an ABSENCE, since the structural reading of this rule is what regressed PHP. `<template>` stays named though it is a no-op for this parser: libxml2 puts its children in the ordinary tree and Ruby measured text leaking through exactly that path, so 8.0.1 states the split rather than calling the exclusion free. Fixture rows `math-subtree`, `svg-inline-icon`, both agreeing with langsys-php-sdk, measured at its tip `e28972c` Paths: the content-block walk (`tokenizeElement`) and the Translate apply walk, which looks up by token and skips excluded and phrase-marked subtrees (eight walk-agreement vectors measured). There is no page path. The Phrase encoder applies no exclusion, and whether TOK-1 binds that path is unruled. |
| TOK-2 | held (strip ruling) | n/a (pure) | Held: the C0 control-character clause, pending the operator ruling. Asserted meanwhile on the collapse function in `tokenizer-convergence`: 23 members and 4 non-members built from code points, the three vectors and control, and the Phrase path; narrowing the class to ASCII reds 22 and widening it to take U+0085 and U+180E reds 2. `tokenizer-convergence` + `canonicalization-agreement` — satisfied with no code: JavaScript's `\s` IS the set 8.0.1 enumerates, this SDK being named the identity authority for it. Verified per codepoint rather than assumed: U+00A0, U+2028, U+000B, U+000C and **U+FEFF** match `\s` and collapse; **U+0085, U+180E**, U+200B and U+2060 do not match and survive — all nine agreeing with the enumeration. Narrowing the class to `[ \t\n\r]` reds 7; widening it to swallow U+0085/U+180E reds 2. Fixture rows `feff-in-text`, `nel-in-text`, `mvs-in-text` |
| TOK-3 | implemented | n/a (pure) | `tokenizer-convergence` + `pure-subpath` — the 27 verified against `langsys-php/src/Html/HtmlParser.php` directly, appended never inserted, with a case asserting list order beats document order. Langsys's point is the sharp one: the same set in a different order agrees on every single-attribute element and diverges only where nobody looks Mutation: not yet recorded (CONF-3). |
| TOK-4 | implemented | n/a (pure) | `tokenizer-convergence` — one normaliser shared by both paths, so "same content, same id" holds by construction. Before: `<img alt="A long\n  description">` kept its newlines while the same sentence in a `<p>` collapsed Registration and lookup now derive the key through one function (`translate` "register and lookup agree on every path"). Mutation: in `src/translate.ts`, set `translateAttribute`'s `originalValue` back to `.trim()`; 3 tests go red. |
| TOK-5 | implemented | n/a (pure) | `tokenizer-convergence` + `interpolate` + `canonicalization-agreement` — `%name%` resolves at RENDER, conditional on the key being supplied, so prose containing percent signs is untouched; and 8.0.1's capture clause holds, `<p>Hello %name%</p>` reaching the same id as `<p>Hello {name}</p>` (`1e4b462c…`). Removing the capture-time rewrite reds 3. Fixture rows `percent-name-in-markup` and its counterpart `brace-name-in-markup`, which is what makes the equality cross-lane DATA rather than one SDK asserting it — both reach `1e4b462c…` and langsys-php agrees on both spellings. `findUnusedParamKeys` was corrected to accept both spellings for the same reason: the predicate and the renderer must agree on what a placeholder is |
| MARK-1 | implemented | n/a (pure) | `translate` — the stamp is compared against an id **re-derived by running the tokenizer over the same subtree**, not read back from the attribute just written, which is what MARK-1's test asks for and would otherwise prove only that a write happened. Mutations: dropping the stamp and stamping a constant each red four |
| MARK-2 | implemented | n/a (pure) | `content-block-identity` — behavioural and cross-module: the attribute `Phrase` exports is the one the tokenizer skips on, and PHP's spelling is accepted alongside it Scope, measured: both spellings of a phrase host are honoured on the block walk and on the Translate apply walk, which leaves a `data-ls-phrase` span untouched. The core does not read content-block host identity while tokenizing, so a nested `data-ls-contentblock` host is folded into the outer block (outer ["A","B"] `13ac7a86…`, inner ["B"] `fb9ed17f…`, child-first and parent-first alike). That sits inside this rule Why and outside its test as written; whether MARK-2 reaches content-block hosts is routed to the operator, and excising them would move ids for every nested block. Mutation: not yet recorded (CONF-3). |
| SSR-1 | implemented | n/a (pure) | `ssr-strategy-isolation`: client collects nothing, server collects, auto collects to its threshold of 5, each case in its own Node process against the built dist. A control shows one shared process contaminates (after the grant case, the same server case collects nothing), and resetting the singleton in that shared case reds the control. Mutation: not yet recorded (CONF-3). |
| SSR-2 | implemented | n/a (pure) | `ssr-strategy-isolation`, one Node process per case. With a grant configured the `server` strategy collects nothing, and says so once per process above debug level through `logger.warn` ("a write grant is configured, so this server render does not collect missing phrases"). There is no notice for `server` without a grant, or for `client` with one. Mutation: remove the `noticeSsrGrantDegradation(strategy)` call in `shouldQueueForWrite`; 1 test goes red. |
| SSR-3 | implemented | n/a (pure) | Artifact inspection. The README's Server-Side Rendering section carries a `> **Precondition…**` callout, its own blockquote rather than a footnote, naming `'server'`, the allow-list and the silent failure. `ssr-precondition-doc` asserts it, with a positive control that the section exists and documents the strategies. Mutation: delete the callout; 1 test goes red. |
| SRV-1 | n/a (profile: server, binding) | - | Profiles `server; and a binding for any render it performs inside a server request scope`. This SDK is neither. |
| SRV-2 | n/a (profile: server, binding) | - | Profiles `server; and a binding for any render it performs inside a server request scope`. This SDK is neither. |
| SRV-3 | n/a (profile: server, binding) | - | Profiles `server; and a binding for any render it performs inside a server request scope`. This SDK is neither. |
| SRV-4 | implemented | n/a (pure) | `seed-catalog` — `t()` resolves on the line after `seedCatalog()`; returns `undefined`, not a promise; an actual deferral (`await Promise.resolve()`) reds 4 of 9; a bare `async` keyword reds only 1 — the return-type assertion — which is why that assertion exists. The body states the split this lane reported: *"Exposing the synchronous seed is the core's half and is provable there."* At `1493dea0` the Profiles line reads `server; **browser core** for the synchronous seed it exposes; and a binding for any render…` — corrected after this lane reported that the body assigned the core a half its profile line denied it. The binding half (calling the seed before hydration, and the hydration-mismatch control) remains not ours |
| SRV-5 | n/a (profile: server, binding) | - | Profiles `server; and a binding for any render it performs inside a server request scope`. This SDK is neither. |
| BIND-1 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| BIND-2 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| BIND-3 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| BIND-4 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| BIND-5 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| BIND-6 | n/a (profile: binding) | - | Profile `binding`; this SDK is the core. Its side of the contract, no ECMAScript #private fields so bindings may forward methods unbound, is pinned by `no-private-fields`. |
| GRANT-1 | implemented | n/a (pure) | Provider callbacks are accepted and resolved per request (`grant-lane`). "Documented as the default form" is asserted on the shipped declarations: `grant-documentation` reads `dist/index.d.ts` for "Prefer the FUNCTION form" and "the bare string is quickstart-only", with a positive control that the `writeGrant` option is present, and fails rather than skips without `dist`. Mutation: drop "Prefer the FUNCTION form." from the JSDoc in `src/types/config.ts` and rebuild; 1 test goes red. |
| GRANT-2 | implemented | n/a (pure) | `grant-lane` asserts the provider is re-resolved per request, not cached. Mutation: not yet recorded (CONF-3). |
| GRANT-3 | implemented | n/a (pure) | `grant-lane` "setWriteGrant re-authorizes". Mutation: in `src/langsys-app.ts`, make `setWriteGrant` return immediately after setting its config, before `LangsysAppAPI.validate`; 4 tests go red, including "issues a fresh authorization carrying the grant". |
| GRANT-4 | implemented | n/a (pure) | `grant-lane` X-Write-Grant header assertions. Mutation: not yet recorded (CONF-3). |
| CACHE-1 | implemented | n/a (pure) | `cache-scope` — the catalog is keyed `langsys:translations:<projectid>:<locale>` and hydrated only once `init()` knows both, so a mismatch is a cache MISS rather than foreign content. Was keyed by neither: a page load restored whatever was stored and `t()` served it before anything could check whose it was. Mutation-checked twice — never-clear-on-scope-change turns the cross-project and cross-locale tests red; module-load hydration turns the superseded-key test red. Superseded keys are removed on first scoping A scoping property, which a stateful fixture could neither prove nor disprove. |
| OBS-1 | provisional | mock | `obs-notice` — a `write`/`ip_write` key resolving `write_enabled: false` warns once, ABOVE debug level, naming the key type and the remedy. Latched on the outcome, so a re-authorization that changes the answer speaks again and one that changes nothing stays quiet. Deliberately silent for a `read` key resolving read-only, which is correct behaviour and would otherwise make this the notice everyone silences. Mutation-checked: dropping the expected-to-write guard turns the read-key test red, dropping the latch turns the repeat test red An unusable capability is what the server returns. Waits on: conf-2 shared contract fixture. |
| WIRE-1 | implemented | n/a (pure) | `api-reachability` WIRE-1 block: X-Authorization on every request, plus the ICU capability header. Mutation: not yet recorded (CONF-3). |
| WIRE-2 | provisional | mock | `api` suite; 204 handled by status rather than content type. Which endpoints answer empty is the API answer. Waits on: conf-2 shared contract fixture. |
| WIRE-3 | implemented | n/a (pure) | `locale` WIRE-3 block + `api` wire assertion. Lowercase `xx-yy` internally and on the wire. **Deliberately supersedes main's BCP 47 casing** (operator ruling); CLAUDE.md invariant 1a and the CHANGELOG carry the reason and the migration note Mutation: not yet recorded (CONF-3). |
| WIRE-4 | implemented | n/a (pure) | `catalog-failure`, with the API made unreachable at `fetch`, beneath the client. Neither `change()` nor `t()` throws and `t()` returns source text; a client that throws does not reject `change()` either. Both shapes measured as violations before the fix are pinned: a fetch that fails with misses present queues and sends nothing despite write capability, and a locale switch that fails mid-scope does not re-register what the previous catalog held. A miss recorded before the fetch settled is held, not sent, and recovery deduplicates it and registers a genuine miss. No discovery miss and no content block are recorded during the outage. Mutations, run in an isolated copy: remove the gate in `missingToken` (2 red); remove the hold in `updateTokens` (2 red); remove the gate in `registerContentBlock` (1 red); do not clear `catalogUnavailable` on success (3 red); remove the catch around the client call (1 red); revert `translations.ts` and `content-block.ts` to the pre-fix tree (7 of 8 red). |
| WIRE-5 | implemented | n/a (pure) | `api-reachability` — redirect **observed** at the double, plus the ordering failure proven A configuration property, observable at the double. Mutation: not yet recorded (CONF-3). |
| CONF-1 | not implemented | - | API-dependent rows whose only evidence is a spy or an outgoing payload: REG-1 (a spy seeing no call), GATE-6, GATE-7 and HINT-9 (reports captured by a mocked sender). Missing: assertions on server acceptance, which needs a double that can refuse and hold state. |
| CONF-2 | implemented | n/a (pure) | Every row records a tier. `_dev_/tally-conformance.mjs` checks the canonical format and status against tier, and `conformance-structure` runs it against planted defects that must each fail. A meta-rule discharged by this document and its checker. |
| CONF-3 | partial | - | SSR strategy cases run one process each (`ssr-strategy-isolation`, with a control that reds). Batteries run in an isolated copy of the working tree, never in `src/`, because the bindings and JS Server load this repo through a symlink; earlier batteries ran in place, each restore byte-checked. A specific re-applicable mutation is recorded for: HINT-10, HINT-12, ICU-1, ICU-3, ICU-5, CID-1, CID-3, CID-4, TOK-1, TOK-4, TOK-5, MARK-1, SRV-4, GRANT-3, CACHE-1, OBS-1, CAT-3, GATE-3, GATE-4, HINT-5, HINT-7, SSR-2, WIRE-4, REG-12. Missing a recorded mutation: GATE-1, GATE-2, GATE-5, GATE-6, GATE-7, GATE-8, CAT-1, CAT-2, REG-1, REG-2, REG-3, REG-4, REG-5, REG-6, REG-7, REG-8, REG-9, REG-10, REG-11, HINT-1, HINT-3, HINT-4, HINT-6, HINT-8, HINT-9, HINT-11, ICU-2, ICU-4, CID-2, TOK-3, MARK-2, SSR-1, GRANT-1 (its runtime half), GRANT-2, GRANT-4, WIRE-1, WIRE-2, WIRE-3, WIRE-5. |

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

Read at langsys `c6b08d11`, `docs/sdk-spec.mdx` blob
`042dedb5b533499a277b88fc9e2ee39ef30a0b89` — **specVersion 8, PUBLISHED**, verified reachable
and matching before use (`git ls-tree c6b08d11 docs/sdk-spec.mdx`), not taken from the report.

Fifth blob this round (`57c8a498` draft → `593abecd` → `318b5941` → `b657b490` → `042dedb5`).
Rather than assume only the rules named in the hand-off had moved, the rule titles and the
Profiles lines for every TOK/MARK/SRV/CID family were diffed between `b657b490` and the
published blob: titles identical, profiles unchanged. Re-derive, never carry forward — and
diff rather than trust the summary of what changed.

Carrying that one as unread rather than asserting it turned out to matter. Langsys has since
said they once sent the Reviewer a blob hash they had not derived, and were caught. A hash
relayed in prose is a claim; `ls-tree` is the check.

All four previously-unconfirmed mappings were correct, and are now confirmed **against the
bodies** rather than against the author's summary of them. TOK-1..5 and MARK-1/2 are profiled
`all`, so they bind this SDK.

The TOK, MARK and SRV rows now sit in the Status table above, one row per rule id.

### Beyond the spec

Three properties this SDK commits to that no rule id names. They are graded on the same terms, but
they are not rule rows, so they sit outside the Status table and the tally does not count them.

| Property | Status | Tier | Evidence |
|---|---|---|---|
| Side-effect-free identity subpath | implemented | n/a (pure) | `pure-subpath` — bare Node under a trapping `globalThis`, import and every call clean for ESM and CJS, main entry as the positive control, export list pinned, and `/pure` proven to share function identity with the DOM path rather than re-implementing it. Now also carries `encodeRichPhrase` (the whole `<Phrase>` encoding, generic over the host's node type) and `findUnusedParamKeys`. No rule id was reported for this; it may be unruled |
| `<Phrase>` key reproducible without a DOM | implemented | n/a (pure) | `rich-phrase-identity` — the encoder moved to `identity.ts` and `encodeRichText` is now a node-shape mapping over it, so there is one implementation of a string that IS the catalog key. Expectations are the PRE-REFACTOR values, measured on the old single-function encoder over 22 inputs and pasted as literals, so they can catch the refactor having moved a key. Mutants: post-order slot numbering reds 8, collapsing per text node instead of once over the assembled string reds 19 (a per-node collapse WITHOUT the trim is an equivalent mutant, 0 red, and is recorded as one — the final collapse runs over the whole assembly, so an earlier one cannot change its output). Expectations are measured under happy-dom and the server lane's under parse5, neither being Chromium; audited as immaterial for these 22 inputs, which contain no raw-text element, no foster-parenting context and no implied-close construct — the three families where parse models disagree. The JS-family half of that gap is now CLOSED by the JS Server lane (`8105faab`): Chromium 153 against parse5 over raw-text, foster-parenting and implied-close families, 9 agree / 0 diverge, with a control proving Chromium demonstrably transformed the input so the agreement is structural. libxml2 is now measured too, by the PHP lane (`db4941a`): **3 of 7** against the JS family's values — implied close agrees 3/3, raw text diverges 0/2 and foster parenting diverges 0/2, because the tokenizer faithfully encodes a different tree and no TOK rule reaches that. The two identity paths have DIFFERENT exposure, measured here: foster parenting splits the `<Phrase>` key while leaving the content-block `custom_id` intact (tokens `['stray','cell']`, arity 2, under both trees — hoisting `<b>` out of the table does not change document order), whereas a raw-text body containing markup splits BOTH, and the content-block half is an ARITY split (libxml2 `['a','b','Keep']` against the JS family's `['a <b>b</b>','Keep']`) which per CID-1 re-keys every block containing one. So "a `<Phrase>` spanning a table is not portable" is right and is not the whole exposure. No rule id covers the `<Phrase>` encoding; `custom_id` rules do not apply to it, since it keys by string and never computes one |
| Registration waits for a catalog in flight | implemented | n/a (pure) | `catalog-in-flight`. A write-enabled cold visit flushed its first misses after the 400ms debounce against a catalog that had not arrived, and re-POSTed registered phrases whenever the fetch took longer (measured at 1s and 5s, not at 300ms); a locale switch had the same window. Queued tokens are now held while a catalog fetch is in flight and flushed on arrival. Routed to the spec as a candidate rule. Mutations, in an isolated copy: no hold (3 red); arrival does not schedule the flush (2 red); the in-flight count is never released (2 red); revert `translations.ts` (3 red). |

**And this repo's test environment cannot see the raw-text split, which is a limit on our own
measurements rather than on the rule.** happy-dom, reached through `innerHTML`, builds a
`<textarea>`/`<title>` body containing markup **the libxml2 way**. Measured here on
`<title>a <b>b</b></title><p>Keep</p>`: tokens `['a','b','Keep']`, arity 3, block id
`d55c2b5c806bde213b0637da096c6b36` — byte-identical to langsys-php's measurement and *not* the parse5
tree the fleet's fixture records for the JS family on that input (`['a <b>b</b>','Keep']`, arity 2).
The Reviewer measured the textarea input `<p>Keep</p><textarea>a <b>b</b></textarea>` the same way
(`['Keep','a','b']`, `43ddeea8…`, again equal to langsys-php); that value is theirs, not re-run here.
An earlier version of this paragraph set the title's tokens against the textarea input's JS-family
value — the arity point held, the order did not, and the two inputs are now named separately. Found by the Reviewer. It is the same class as the `<noscript>`
artefact: the test environment's parser is part of the measurement, and happy-dom is not a model of
Chromium on exactly the constructs where parse models differ.

Two consequences, both recorded rather than worked around:

- **The raw-text and foster-parenting vectors stay OUT of `canonicalization-reference.json`.** They
  diverge below the tokenizer, so no implementation can make them agree — and worse, here they
  would *falsely agree*, because our harness builds the libxml2 tree. A row that passes for the
  wrong reason is worse than no row.
- **JS-family raw-text tokens were derived here, and have since been measured.** When this lane reported the arity split to the PHP lane it named `['a <b>b</b>','Keep']` as the JS-family value for the title input. That value was *derived* here, not measured, and this environment would have produced the opposite; the provenance caveat sat on the foster-parenting derivation and not on this one, which was the inconsistency worth recording. The Reviewer has since measured the parse-model rows on **parse5 7.3.0** through `langsys-js-server`'s own `tokenizeHtml()` (`parseFragment` with scripting enabled, the path `blockId()` uses), with controls: `tokenizer-reference.json` cases 2, 4, 9, 12 and 14 match, and `skipCodeElements: false` gives case 12 `["Keep","var a=1;",".a{}"]`. Every array they report equals the derivation: raw-text-textarea `["Keep","a <b>b</b>"]` `526f61b1…`, raw-text-title `["a <b>b</b>","Keep"]` `196856a6…`, foster-stray-element `["stray","cell"]` `c9a556e3…`, foster-loose-text `["loose text","x"]` `0a1f1ae9…`, implied-close `["one","two"]` `499d5997…`, all under category `'UI'`, with the JS and PHP hashers agreeing on every id. Chromium still covers only the phrase keys, and this harness still cannot see the raw-text split, so the vector file is unchanged.

**A related precision on that comparison.** The foster-parenting block id this lane derived,
`c9a556e320152d0bd3fc239bbb2b6d40`, matches langsys-php's measurement — but both sides used
category `'UI'`, which neither fixture states. Under no category the same tokens give
`b67f0bc9259c1341bcca9555db386076` (CID-2 folds `''` and `'__uncategorized__'` together). So the
**token arrays** agree across two languages and two parsers, which is the finding; the **id**
agreement additionally required a shared assumption that was never written down. Measured here at
the Reviewer's prompting.

**Three more facts about this harness, measured here on happy-dom 20.10.2**, because the test
DOM's parser is part of every measurement made through it. The parse5 side of each is the
Reviewer's measurement.

- **Carriage returns are not normalised.** A lone CR stays U+000D and a CRLF stays U+000D U+000A,
  where parse5 and libxml2 2.14+ normalise both to LF. Id-neutral: both characters are in the
  collapse set, so the token comes out the same either way.
- **NUL is kept.** U+0000 in text survives into the token in this harness, where a browser and
  parse5 drop it. That is **not** id-neutral: a vector carrying NUL would derive a different id
  here than in a browser, so none is written.
- **C0 controls are kept, as parse5 keeps them.** U+0001 and U+001C survive in text and in
  attribute values, whether written raw or as `&#x1C;`. U+000B still collapses to a space,
  unchanged, since control-character handling is held pending the strip ruling.

Spec 5c5c0723 says parse5 and happy-dom keep these characters "the same way" as libxml2 2.14. That
holds for keeping C0 controls and not for CR normalisation. It changes no id, and was reported to
the Reviewer as a wording note.

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

### The shared tokenizer fixture contradicted itself — now corrected upstream

`tokenizer-reference.json` carried a row named **"script and style contents are never
harvested"** whose expected tokens were `["Keep", "var a=1;", ".a{}"]`. The name stated the
intent; the data recorded the bug. Both SDKs matched the data, so both harvested CSS and
JavaScript as translatable phrases and sent them to paid machine translation — while the row's
name said they did not. The fixture locked in the behaviour it was named for preventing.

Found by implementing TOK-1: the fix turned that row red. The vendored copy was not edited — a
named override in `tokenizer-cross-impl` held the corrected expectation, and a second test
asserted the override still *disagreed* with the fixture, so a later upstream correction would
fail it rather than let a stale exception accumulate.

**That is how it ended.** PHP corrected the row (`ba9fb7b`, blob `5689f3c1`, note "CORRECTED
2026-09-11"), the disagreement test went red with *"delete this override"*, and the override and
its test were deleted. The fixture is re-vendored at the corrected blob and the row passes on
its own terms. A self-retiring exception is worth its extra test: the alternative is an override
nobody revisits, quietly asserting a divergence that has stopped existing.

### The two unruled divergences: ruled by 8.0.1, and now resolved on both sides

Retained as a record rather than deleted, because the shape of the resolution is the useful part.

Both were recorded here as measured-but-unruled, with **no fixture row added deliberately** — that
file's expectations are "what this SDK produces, which the spec agrees with", and with the spec
silent a row would have encoded a guess as the expectation. 8.0.1 has now ruled, and in both cases
it ruled for this SDK's behaviour:

- **The whitespace collapse set** is enumerated as exactly what JavaScript's `\s` matches, this
  SDK being named the identity authority. U+FEFF is a member (collapses); U+0085 and U+180E are
  named as non-members that must survive. Previously: this SDK dropped U+FEFF and PHP kept it;
  PHP collapsed U+0085 and U+180E and this SDK kept them. **This SDK was conformant on all three
  before the rule existed** — `\s` already matched that set — and the rule now names POSIX and PCRE classes, Ruby's `[[:space:]]` and PCRE with the unicode flag, as rejecting U+FEFF, which is how a hand-written class under-collapses it.
- **`%name%` inside markup** normalises to `{name}` BEFORE the id is derived. Previously: this SDK
  normalised at capture (`Hello {name}`, `1e4b462c…`) and PHP tokenized the raw markup
  (`Hello %name%`, `bb74011a…`). The spec at blob `8e2527b9` quoted both ids and ruled for the normalising path. From `5c5c0723` it rules the same way but names neither id, saying they belong in the fixture row the JS core derives, which is where they now live (`percent-name-in-markup`, `brace-name-in-markup`).

**Four rows were then specified by Langsys and derived here as the fixture's owner** — the CID-3
precedent for who specifies versus who derives. Inputs and expected behaviour from the spec, ids
from this SDK's tokenizer: `feff-in-text`, `nel-in-text`, `mvs-in-text`, `percent-name-in-markup`.

**Re-measuring for those four found that all six previously-recorded divergences are also gone.**
PHP fixed the collapse set and the code-bearing-subtree exclusion in `717673d`, so the vector file
now records **26 rows, 26 agree, 0 diverge** where it recorded 13 of 19 (23 after the four specified rows, then `math-subtree` and `svg-inline-icon` with the TOK-1 fix, then `brace-name-in-markup`). The stale half of that is
worth naming: this file and the vector file had both been asserting divergences that had stopped
existing, and nothing in either would have noticed — the vector file's self-cleaning test checks
that a divergence carries a *note*, not that it is still true. Re-measuring is the only thing that
catches it, which is why the lane measurements are now re-derived on every write alongside the
spec revision.

**The all-agree result was positive-controlled before being believed**, because 23-of-23 is exactly what a broken comparison produces. Three controls, recorded in the vector file under `harness_control`: `<p>a\u000Bb</p>` and `<p>a\u000Cb</p>` both DIVERGE — langsys-php-sdk's libxml2 2.9.13, a pre-2.14 libxml2, drops VT and FF from DOM text where a JS DOM keeps them and collapses them to a space, reproducing what spec 5c5c0723 records as a libxml2 version boundary. libxml2 2.14 and newer keep them, so this control holds only while that host runs a pre-2.14 libxml2, and a replacement has to be chosen rather than the expectation flipped when it upgrades — and feeding the two sides different input DIVERGES, proving the comparison is not structurally returning agreement. Those two characters are **not** fixture rows:
they diverge below the tokenizer, so no implementation can make them agree, and a row whose
expectation can never be met would sit here failing forever and teach a reader to ignore failures.

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

**Which shapes are tried, and when a match is attached (CID-3, CID-4).** After the current
id, the lookup tries every shape in the fleet's 20-row legacy fixture, vendored from
langsys-python at blob `dc555646…`: the code-unit hash, PHP's pipe-join hash, and the
corrected hash over the pre-convergence tokens, over the uncategorised slot spellings the
reference SDKs use (`''` and `'__uncategorized__'`, plus `null` for the code-unit hash).
None of those id spaces is injective, so a match is attached only when the stored block
holds the current block's phrases, compared as sets after hashing normalisation. The
collision above is declined rather than attached, and the block registers under its own id.

## Gaps, ranked by cost

1. **HINT-6 — resolved, retained for the record.** The SDK preserved hashbang fragments while
   the server canonicalised them, which would have dispatched the renderer to a route
   hashbang apps do not resolve. Resolved by the server splitting `normalize()` (verbatim,
   feeds dispatch) from `dedupKey()` (folds `#!/`→`#/`, suppression only) — neither leg
   conceded, and the two concerns that had been sharing one function were separated. Nothing
   outstanding.

2. **A page whose URL carries a credential-shaped query param is never discovered.** Deliberate,
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

3. **Thirteen rows are `provisional`.** GATE-1, GATE-2, GATE-5 to GATE-8, REG-1, REG-8 to REG-10, HINT-9, OBS-1 and WIRE-2 govern properties that depend on what the API answers, and their doubles cannot refuse or hold state. Not fixable in this repo alone: each waits on the shared stateful contract fixture (CONF-2, Open), which the spec says gates `implemented` in every SDK.

4. **CONF-1, not implemented.** REG-1 is proven by a spy seeing no call, and GATE-6, GATE-7 and HINT-9 by reports captured from a mocked sender. Those are API-dependent properties asserted on what the SDK sent, not on what the server accepted.

5. **CONF-3, partial: 39 of the 63 runtime rows record no mutation.** The rows that do are listed in the CONF-3 row. Batteries now run in an isolated copy of the working tree: consumers load this repo through a symlink, and a battery that rewrites `src/` in place voids their counts for as long as it runs, even when every byte is restored. The `setWriteGrant` gap once recorded here is closed: making `setWriteGrant` return right after setting its config turns 4 `grant-lane` tests red. SSR strategy cases now run one Node process each (`ssr-strategy-isolation`), with a control showing that one shared process really does contaminate.

   One place this was done, recorded because the result was counter-intuitive: the logger's
      React-Native detection is covered by a pair of tests, and under mutation only the BROWSER
      one kills a latched implementation. The RN test passes either way — the test environment
      is `node`, so `window` is undefined at import and a latched check yields plain text for
      the wrong reason. The test that looks like it verifies the fix does not; the control does.
      A negative result is only evidence once the search has been shown able to return a
      positive, and which half of a pair carries that proof is not always the obvious one.

6. **A nested content-block host is folded into the outer block. Routed to the operator.** The tokenizer does not read content-block host identity, so `<div><p>A</p><div data-ls-contentblock="…"><p>B</p></div></div>` gives the outer block `["A","B"]` (`13ac7a86…`) and the inner `["B"]` (`fb9ed17f…`), registering `B` twice, in either render order. Excising stamped hosts would move the id of every nested block. Measured blast radius in fleet code is zero: no browser binding, example or doc nests `<Translate>` inside `<Translate>`. Customer usage is unmeasured.

7. **React Native reaches no teardown flush. Routed to the operator.** `installTeardownFlush` returns early without `document`, so on React Native anything still queued when the app is killed is lost, worst under REG-8 backoff. An injected teardown signal in the `setPersistStorage` style is proposed with the React Native lane: the binding adapts the lifecycle event, and the core keeps the send.

8. **TOK-2 is held.** Its control-character clause waits on the operator's ruling on stripping C0 controls. The rest of the rule is asserted on the collapse function directly.

9. **REG-11 — the permitted suppression half is not implemented.** The warning is in and nothing is skipped, which conforms. The optional second signal — suppress when a longer catalog entry shares the prefix — would need a prefix scan of the catalog on every miss, and buys only the pollution case the warning already surfaces. Recorded as a deliberate omission rather than a gap.

10. **OBS-1's notice covers capability, not every inert state.** The write-capability warning is now above debug on both channels. HINT-9's reporting-disabled case stays debug-only deliberately — the customer chose that setting, so it is a configuration, not a fault.

## Not applicable

`HINT-2` (`n/a (profile: server)`), `SRV-1`, `SRV-2`, `SRV-3` and `SRV-5` (`n/a (profile: server, binding)`) and `BIND-1` to `BIND-6` (`n/a (profile: binding)`), one row each in the Status table. This package is the core browser implementation, so none of those profiles applies. Recorded with a revision because
an `n/a` claim is a claim about the rule's Profiles line: a stale `implemented` row has a
test that will eventually fail, whereas a stale `n/a` row has nothing that can ever
contradict it.
