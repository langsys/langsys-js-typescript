## Unreleased

### Changed — BREAKING

- **Locale identifiers are now lowercase `xx-yy` everywhere, not BCP 47 canonical casing.** `canonicalizeLocale('en-US')` returns `en-us`; `zh-Hant-TW` returns `zh-hant-tw`. This is a public export, and `currentlyLoadedLocale` carries the same form — so any binding or application comparing against cased strings (`locale === 'en-US'`) stops matching. Compare against the normalized form, or run your own value through `canonicalizeLocale` first. Note this is breaking against **0.6.5**, which is published and emits the canonical form.

  The API's database stores every locale lowercase — script subtags included, as `az-cyrl` / `bs-latn` — and its request middleware lowercases before any query runs. Sending that form is therefore the only way to behave identically on a route that does *not* mount that middleware, and the routes most likely to miss it are the legacy ones carrying the oldest clients. Relying on a normalization we cannot see, cannot version, and will not be told about when it moves is the actual risk; sending lowercase costs nothing.

  CLDR handling is unaffected. `Intl` canonicalizes its own input, so `new Intl.Locale('zh-tw').maximize()` still yields `zh-Hant-TW` — a `zh-Hant` reader still never receives a `zh-Hans` catalog.

- **`detectPreferredLocale` returns `false` when nothing in `supportedLocales` matches.** It previously returned the user's own first preference — a locale the caller had just said it does not support — so the documented `detectPreferredLocale(header, supported) || 'en-us'` idiom could never reach its default, and the app fetched a catalog that does not exist. Callers already using the `||` idiom get the behaviour it always described. Callers relying on the old return value need an explicit fallback.

- **The persisted catalog moved from the `translations` storage key to `langsys:translations`.** A bare `translations` key in a host app's `localStorage` is a collision waiting to happen, and a collision corrupts a catalog rather than failing. The old key is read once on first load so existing caches migrate rather than being discarded, and is never written back — a downgrade still finds its cache where it left it.

### Added

- **`apiUrl` init option.** Points the SDK at a different API host from inside `init()`, applied before authorization. `LangsysAppAPI.setBaseUrl()` still works but has to run *before* `init()`, and running it after leaves the SDK permanently inert with no error — the option removes the ordering rather than documenting it.

- **`setPersistStorage(storage)` and the `PersistStorage` type.** Injects a synchronous storage backend for environments without a usable `localStorage` — React Native, workers. Signals created before the injection are re-hydrated from it, which is the point: the catalog store is built at module load, long before an app can hand us MMKV.

- **Debug notice when an interpolation argument is defaulted.** A gendered target locale can introduce an argument the source phrase never had (`{name}` → `{name_gender, select, …}`), which the SDK already recovered from silently. Silence is also what made it undiscoverable — the argument appears nowhere in the source. Names the argument and the locale, once per template+locale, debug only.

- **Server-gated writes and automatic content discovery** (ticket 838). Write capability is decided per session by the server via `write_enabled` rather than inferred from the key type, since a public key shipped in browser JS is extractable. Sessions that cannot write report the page URL instead, so the discovery renderer can visit it from an allow-listed address and register what it finds. Adds `writeEnabled` and `autoDiscovery` signals, `writeGrant` / `setWriteGrant` for login-walled apps, and a `./browser` build for pages with no bundler.

### Fixed

- **`Phrase` and `Translate` no longer hang forever when no catalog can arrive.** Both await an internal ready gate before rendering, and nothing resolved it when `init()` refused the config (missing `projectid`, `key`, or `UserLocaleStore`) or when authorization failed. The result was a permanent blank render with no error, on the commonest misconfigurations there are. They now fall back to source text.

- **`Translate` re-renders when the catalog changes, not only when the locale does.** A same-locale catalog arrival — the first fetch completing, a `refresh()`, a token-flush write-back — replaces the store without changing the locale, so the element kept showing source text with a correct catalog sitting in memory.

- **`Translate` no longer destroys the markup inside single-token content.** It replaced the element's entire contents with one text node, so a `data-testid`, `id`, or ref on a child element stopped existing after mount. It now writes the one text node and leaves the structure alone. Single-token blocks are also resolved against the content-block catalog, which flat `t()` cannot see into.

- **The token-flush backstop interval only runs while something is queued.** It previously started at setup and ran for the life of the page whether or not anything was ever queued — a wakeup every three seconds forever, and React Native takes the same branch because it defines `window`.

- **`getLocaleName` says which of its two failures happened.** Calling it before the locale data is loaded and asking for a locale that isn't there both return `''`, and both reported a failed match — sending developers to check a locale code that was fine.

- **Debug logging is readable in React Native.** RN defines `window` but cannot render `%c`, so every line came out as a literal `%cLangsys Debug` followed by an unrendered CSS string.

- **`persist` works in React Native.** RN defines `window` but not `window.localStorage`, so the catalog silently ran in memory and was re-fetched on every cold start. Detection is now by probe rather than by `typeof window`.

- **Discovery hints no longer strip credential-shaped query parameters — they decline the whole report.** Stripping produced a URL that was no longer the page the miss came from, so the renderer registered content from a different page, and pages distinguished only by that parameter collapsed onto one key. `key` and `code` are also no longer treated as credentials: `?key=pricing` and `?code=US` are ordinary selectors on exactly the pages discovery exists to find. Parameter matching is now separator-insensitive, so `api-key` and `x-api-key` are caught alongside `api_key`.

- **`src/interpolate.ts` is a text file again.** It carried one literal NUL byte, which made git classify the whole file as binary — no diff, no blame, no three-way merge — so every change to it was invisible to review while still shipping. No behaviour change: the separator is the same character, written as an escape.

Several of the fixes above were found by Gianluca Capra (PRs #2 and #3, and `e1e9e83` for the NUL byte — the first fix, and the one carried here); the implementations here are re-derived against the current base.

## 0.6.5 - 2026-08-16

### Added

- **Debug warning when a locale tag is not valid BCP 47.** `canonicalizeLocale` falls back to best-effort casing rather than throwing, which is the right behavior — but the return value cannot signal that it happened: a best-effort string is indistinguishable from a successfully canonicalized one. So a typo'd config locale degrades to a silent failed catalog lookup, and the app renders base language, which is exactly what a legitimately-untranslated locale looks like. Nothing downstream can tell the difference, so the warning is emitted where the information still exists. Behavior and return values are unchanged; silent in production.

  Found by applying a predictive form of a pattern this release series kept hitting, contributed by the Svelte binding: **look for any fallback whose output is drawn from the same value space as its success output.** That makes the class searchable by inspection rather than discoverable by tripping over it — null-as-zero, empty-string-as-absent, best-effort-locale-as-canonical.

## 0.6.4 - 2026-08-16

### Fixed

- **A missing ICU argument no longer dumps the message source to the page.** `intl-messageformat` throws when an argument is absent, and the fallback ran the simple interpolator — whose pattern deliberately cannot match an ICU slot, so the entire construct passed through untouched. A phrase promoted to `{name_gender, select, …}` rendered as literal ICU source in front of users.

  This is reachable with no caller mistake: langsys-ai's ICU promoter *introduces* a select argument the source phrase never had — a plain `{name}` becomes `{name_gender, select, …}` in gendered target locales. The application cannot supply `name_gender`; it doesn't exist in the phrase the developer wrote, and nothing tells them the target grew one. Every app translating into a gendered locale hits it.

  Recovery, agreed with `langsys-php` so a shared catalog cannot render two different sentences for one input:

  | slot | missing-argument behavior | outcome |
  |---|---|---|
  | `select` | take the `other` branch | a correct sentence — `other` is what an unknown gender should render |
  | `plural` | take `other`, render `#` as `{argName}` | sentence survives with a visible gap; nothing can be inferred for a count |
  | `{name}`, `{n, number}`, dates | render as `{argName}` | matches the simple path's rule that unknown keys stay visible |

  The asymmetry is deliberate: `select` is genuinely recoverable, `plural` is only made less bad. Arguments that ARE supplied are untouched and recursed into, so a missing argument nested inside a satisfied branch still recovers. `plural`/`select` without an `other` branch is malformed ICU and is left alone, falling through to the simple path as before.

  **A `null` argument counts as missing**, matching `langsys-php`. It doesn't throw — `intl-messageformat` coerces null to `0` — so `{count, plural, …}` rendered `0 items`. That is worse than it looks: a genuine `0` also renders `0 items`, so a bug and valid data became indistinguishable, in the output, in a screenshot, and in a bug report. A real `0` still renders `0 items`; only null and absent produce `{count} items`.

  Found by `langsys-php` from a report against their SDK; both implementations had it, by different mechanisms. Verified against their shipped v1.3.1 behavior, including a nested case where an *unsatisfied* branch's missing argument correctly costs nothing (`{g, select, f {Ella} other {{n, plural …}}}` with `g='f'` renders `Ella`).

## 0.6.3 - 2026-08-16

### Fixed

- **`<select>` option text was harvested twice, diverging `custom_id` from every other Langsys SDK.** A `<select>` special case pushed each `<option>`'s text, and the ordinary text-node walk then pushed it again — `<option>` cannot contain elements, so the walker already covered it. Any content block containing a `<select>` therefore produced `["S","S"]` where `langsys-php` produced `["S"]`, and had a different `custom_id` in the two SDKs since before either was audited. The fixture suite could not see it: those fixtures are synthetic token lists that never touch a DOM.

  **Migration is automatic and lookup-only**, extending the mechanism 0.6.0 introduced. Three historical id shapes are now tried before registering:

  | tokens | hash | registered by |
  |---|---|---|
  | corrected | corrected | 0.6.3+ (current) |
  | legacy (duplicated) | corrected | 0.6.0 – 0.6.2 |
  | legacy (duplicated) | legacy | before 0.6.0 |

  Registration always uses the corrected id, so the legacy-keyed population can only shrink. Content without a `<select>` is unaffected — its token list is identical either way, so nothing needlessly rebases. Without this fallback the upgrade would have been silent in the worst direction: a dropdown quietly reverting to source text, with nothing erroring to explain it.

- **`legacyTokenizeElement(element)`** — the pre-0.6.3 token list, exported for migration tooling. Lookup-only; never register under an id derived from it. Deprecated on arrival.

### Added

- **Four standard attributes are now harvested: `label`, `aria-description`, `aria-valuetext`, `aria-roledescription`.** `langsys-php` harvests a superset of our list; diffing the two showed nothing JS-only and 16 PHP-only, of which these four carry real user-visible text. `label` is what a user reads in a `<select>` picker (`<option>`, `<optgroup>`, `<track>`) and is invisible to sighted testing that only inspects option text; the three ARIA attributes are read aloud by screen readers, so leaving them untranslated degrades accessibility specifically for the users least able to work around it.

  The remaining twelve PHP-only attributes are framework conventions (Bootstrap `data-bs-*`, Rails-style `data-confirm`, loading/notification text) and are deliberately **not** mirrored — they're written by server-rendered templates, and a JS app renders those strings through its own components.

  **Note:** a content block containing one of these attributes now yields a different token list, and therefore a different `custom_id`. Such blocks re-register and their existing translations orphan. The 0.6.0 legacy-id fallback cannot help here — it re-hashes the *same* tokens, and this changes the tokens themselves. Affected population is only blocks that use these four attributes.

## 0.6.2 - 2026-08-16

### Added

- **`data-notrans` is now honored as an alias for `translate="no"`.** `langsys-php` accepts it as an author-facing opt-out, for hosts whose templating strips unknown bare attributes or where `translate` collides with another tool — and it survives into `translatePage()` output. On SSR handoff there is one DOM, so content an author marked "do not translate" was being extracted and registered by whichever SDK walked it. Presence is intent; an explicit `"false"`/`"0"` opts out of the opt-out, compared after trimming. `translate="no"` is now matched case-insensitively too, also mirroring PHP.
- **`isTranslationExcluded(element)`** — exported alongside `isPhraseMarked`, for wrappers that tokenize through their own templating rather than delegating to the DOM class.

### Fixed

- **Phrase-marker values are trimmed before comparison**, so `data-langsys-phrase=" false "` opts out like `="false"` does. This matched `langsys-php` at the time it shipped; auditing the difference showed the gap was drift — their exclusion check gained a trim their phrase check never did — and they normalized on their side, so both SDKs now trim in both places. `isPhraseMarked` is also the method name in both SDKs now, so the correspondence is checkable at a glance.

### Notes

- Asking `langsys-php` whether to mirror `data-notrans` rather than implementing against their code surfaced a bug on their side: their truthiness test was inverted at both ends — bare `data-notrans` did nothing, while `data-notrans="false"` excluded. Had this been implemented from their source as it stood, it would have faithfully reproduced that. Their fix landed first; this mirrors the corrected semantics.

## 0.6.1 - 2026-08-15

### Fixed

- **`data-langsys-phrase="false"` / `="0"` are now honored as opt-outs.** 0.6.0 taught the tokenizer to skip subtrees carrying `langsys-php`'s keep-together marker, but matched on attribute presence alone. PHP's `hasPhraseAttribute()` treats presence as intent *while letting an explicit off value opt out* — so we skipped subtrees the author had deliberately un-marked, leaving that content translated by neither SDK. Matching is now value-aware and case-insensitive, mirroring PHP exactly.

  Found by reading `HtmlParser.php` rather than trusting a summary of it — the same second-hand-documentation error this class of bug keeps producing.

## 0.6.0 - 2026-08-15

### Fixed

- **`md5` now agrees with a standard UTF-8 MD5 for all input.** It packed UTF-16 code units straight into byte lanes, so it matched a real MD5 only for ASCII. Two consequences, both confirmed against the published 0.5.0 build:
  - *Cross-SDK divergence (certain, universal).* Every non-ASCII content block received a different `custom_id` in the JS SDK than in `langsys-php`, which hashes UTF-8 bytes. Any project rendering the same block through both SDKs got two catalog entries for one block.
  - *Self-collision (real, rare).* A character's high byte was OR-ed into the neighbouring byte lane, vanishing whenever that lane already carried those bits — so `"éa"` and `"ǩa"` hashed identically, as did `"Café"`/`"Cafǩ"` and `"Don’t"`/`"Don<0x19>t"`. Distinct content blocks could share one `custom_id`, letting one block's translations serve another's content. A 20,000-phrase scan of realistic copy found no collisions, so reaching one needs a specific pairing — but the failure mode is silent and wrong when it happens.

  The message bit-length was also a code-unit count rather than a byte count, so astral characters (`😀`) mis-lengthed the message independently of the packing bug.

  **Migration is automatic and lossless.** `Translate` now resolves a content block against the corrected id first and falls back to the legacy id when that misses, so blocks registered by an older SDK keep serving their existing translations instead of orphaning. The fallback is **lookup-only** — registration always uses the corrected id, so the legacy-keyed population can only shrink. **Pure-ASCII ids are byte-identical to before**, so only non-ASCII blocks are affected at all.

  Found by the `langsys-skill` and `langsys-php` agents; the collision mechanism and the JSON-offset dependency below were established jointly with them.

### Added

- **`md5Legacy(input)`** and **`generateLegacyCustomId(category, tokens)`** — the pre-0.6.0 hash, exported for migration tooling and cross-SDK reconciliation. Lookup-only; never register new content under these. Deprecated on arrival, to be removed once catalogs have been rebased.

### Notes

- Collisions are a property of the **final hashed string**, not the phrase: `JSON.stringify` shifts every character's offset, so a pair that collides standalone may not collide once wrapped, and changing `category` moves every character into different lanes. Reason at the `generateCustomId` level, never at bare `md5()`.

## 0.5.0 - 2026-08-14

### Changed (breaking, types only)

- **`PhraseOptions.params` is now `Record<string, ParamPrimitive>`**, matching `TranslateOptions.params` and `t()`. It was `Record<string, unknown>`, which allowed values — objects, arrays, functions — that interpolation can only render as `[object Object]`. No runtime behavior changes; this is a compile-time narrowing that surfaces those calls as errors instead of silently rendering garbage. `Phrase.setParams()` now also accepts `undefined`, matching `Translate.setParams()`.

  **Impact — two distinct cases.** First, and most visible to application code: **passing an object or array as a param value no longer compiles** (`params={{ user: someObject }}`). That code was already broken at runtime — interpolation could only render it as `[object Object]` — so this converts a silent bug into a build error, but it does bite at build time. Second: code typing its params as `Record<string, unknown>` and forwarding it no longer compiles, which covered all three framework bindings; the fix there is one line per call site, declaring `Record<string, ParamPrimitive>` (exported from the package root). Usefully, that narrowed declaration compiles against 0.4.x *and* 0.5.0, so wrappers can land it independently of the version bump. Runtime is unaffected throughout — code that skips the type change still *works*, it just fails `tsc`.

### Added

- **`Phrase` is documented in the README for the first time.** It's been exported since 0.1.0 but had no section, so the only documented tool for markup-bearing content was `Translate` — which splits at tag boundaries and is the wrong choice for a sentence. The new section covers the three reasons it exists (grammatical agreement, reordering, phrase-key stability), and the `Translate` section now shows the literal per-text-node split so the trade-off is visible at the point of decision.
- Warning against building phrases with template literals (`` t(`Hello, ${name}!`) ``), which registers every runtime value as its own catalog phrase and pollutes the catalog shared across every Langsys SDK.
- Params doc comments now name the `%name%` markup spelling alongside the canonical `{name}`, including Vue's `{{ name }}` case.

## 0.4.3 - 2026-08-08

### Fixed

- **The params diagnostic no longer names the wrong framework.** 0.4.2's warning hardcoded "the framework compiler (Svelte/JSX)" and the `{key}` spelling, which misdiagnoses Vue users — Vue consumes `{{ key }}`, not single braces, so a Vue developer hitting the warning was pointed at a syntax their framework never touches. The message is now framework-neutral and names both brace spellings.

## 0.4.2 - 2026-08-08

### Added

- **Debug-mode diagnostic for the `{key}`-in-markup mistake.** Writing `{name}` instead of `%name%` inside `<Translate>`/`<Phrase>` content fails silently — the framework compiler substitutes it before the SDK sees the text, so the base locale still renders correctly and only translated locales break. The SDK can't observe the original braces, but the fingerprint is unmistakable: `params` supplied with no matching placeholder in the captured content. When `debug` is on, that now emits a warning naming the offending key and the exact fix. The check re-runs only when the params key-SET changes, so a ticking counter doesn't spam the console, and it's silent in production.
- **`findUnusedParamKeys(texts, params)`** — the underlying detector, exported for wrappers that want the same check around their own rendering. Treats both `{key}` and ICU `{key, plural, …}` as used.

## 0.4.1 - 2026-07-08

### Added

- **`%key%` — markup-safe placeholder spelling for DOM content.** Bare `{key}` written inside `<Translate>`/`<Phrase>` markup is consumed by framework compilers before the SDK ever sees it (Svelte compiles it to an expression; JSX evaluates it). Markup now also accepts `%key%`, which survives compilation as literal text. It's additive — plain `{key}` in vanilla HTML keeps working — and `%key%` is normalized to canonical `{key}` at every capture boundary (content-block tokenizer, `Translate` snapshots, `Phrase` encoding), so the Translation Manager, the wire payloads, and translators only ever see the `{key}` form. Keys are restricted to identifiers (`[A-Za-z_][A-Za-z0-9_]*`), so literal `%` in prose ("20% off", "50% to 60%") can never false-match. `t()` phrases are JS strings with no compiler collision and stay `{key}`-only.
- **`normalizeMarkupPlaceholders(text)`** — the normalizer, exported for framework wrappers that render content-block tokens through their own templating.

## 0.4.0 - 2026-07-08

Params interpolation for the `Translate` DOM class — content blocks can now carry runtime values the same way `t()` phrases do.

### Added

- **`TranslateOptions.params`** (`Record<string, ParamPrimitive>`) — single-brace `{key}` placeholders, same syntax and semantics as `t()`: unknown keys fall through untouched so missing data stays visible, and Number/Date values are formatted per the active locale's CLDR rules. Interpolation applies everywhere resolved text lands in the DOM — content-block text nodes, translatable attributes, `<select>` option text, and the single-text-run path. Untranslated fallbacks interpolate too, and the base locale gets a render pass when params are present, so placeholders never leak into the UI.
- **`Translate.setParams(params)`** — swap params after mount (e.g. a changed count) and re-render, mirroring `Phrase.setParams`. The framework bindings expose this as a reactive `params` prop on their `<Translate>` components: `langsys-js-svelte` ≥ 3.3.0, `langsys-js-react` ≥ 0.4.0.

### Fixed

- Content-block text replacement no longer treats `$`-patterns (`$&`, `` $` ``, `$1`…) in translations or interpolated values as `String.replace` directives — they now render literally.

## 0.3.0 - 2026-07-03

Full CLDR compliance, matching the backend's CLDR migration. Everything rides on the platform's native `Intl` APIs — no new dependencies, no bundled locale data.

### Changed

- **Locale identifiers are now BCP 47 canonical everywhere.** `en-us` → `en-US`, `zh-hant-tw` → `zh-Hant-TW`, `en_US` → `en-US`, legacy aliases resolved (`iw` → `he`). Canonicalization happens at every input boundary (init config, user-locale store emissions, `detectPreferredLocale`, API params), so the canonical form is what goes on the wire and what keys every internal cache. Lowercase locales in existing configs keep working — they're canonicalized on the way in.
- **`detectPreferredLocale` matching is script-aware** via CLDR likely-subtags (`Intl.Locale.maximize()`). `es-MX` matches a supported `es-ES` or `es`; `zh-TW` matches `zh-Hant` and never `zh-Hans` — cross-script fallbacks are refused instead of guessed. Previously matching truncated to the bare language code, which could hand a Traditional Chinese reader a Simplified catalog.
- **Simple `{name}` interpolation formats numbers and Dates per the target locale's CLDR rules.** Numbers go through `Intl.NumberFormat` (`1234.5` → `1.234,5` in `de-DE`); Dates through `Intl.DateTimeFormat` medium date style (previously ISO 8601). Pass values as strings to opt out — e.g. IDs that must not get grouping separators.

### Fixed

- **Style-less ICU arguments (`{n, number}`, `{d, date}`, `{t, time}`) now format correctly.** The ICU detector required a style argument, so these valid ICU forms fell through to simple interpolation and rendered as literal `{n, number}` text.
- Locale equality checks (fetch dedup, country/currency/dial-code caches) no longer miss when the same locale arrives with different casing.

### Added

- `canonicalizeLocale(locale)` — exported BCP 47 canonicalizer, useful when seeding your own `UserLocaleStore`.

## 0.2.3 - 2026-07-01

> Reconstructed retroactively (2026-08-15) from git history — this release shipped without a changelog entry.

### Fixed

- **`ready()` never settled on an SSR-seeded locale, hanging every content-block consumer.** The SSR handoff calls `markLoaded()` to prime the fetch cache so `change()` short-circuits, but `readyResolve()` lived only in `getTranslations()`. With no fetch ever firing, `Translate` and `Phrase` awaited `ready()` forever on the seeded locale and never rendered. Now resolved in `markLoaded()` — a seeded catalog counts as ready — and in the legacy `skipFetch` branch of `change()`, which had the same hole.

## 0.2.2 - 2026-06-24

> Reconstructed retroactively (2026-08-15) from git history — this release shipped without a changelog entry.

### Fixed

- **Switching back to the initial/SSR locale left the previous language on screen.** The init-time locale subscription recomputed `skipFetch` on every settle as `initialTranslationsLocale === locale && !!initialTranslations`. Since `initialTranslations` stays truthy for the whole session, every *return* to the initial locale skipped `change()`'s store updates, so the previous locale's catalog stayed active and the `t` signal never rebuilt. Replaced the persistent skip flag with `Translations.markLoaded()`, which primes the same `lastLoaded` cache `change()` consults: the first settle after the SSR handoff is still a cache hit with no redundant fetch, but switching back later flows through `change()` normally.

## 0.2.1 - 2026-06-12

### Changed

- **Migrated off the deprecated API routes onto the current endpoints.** No public API change — the same `t()`, `<Phrase>`, and `<Translate>` usage now talks to:
    - Reads: `GET /translations?project_id=…&locale=…` (was the deprecated `GET /projects/{id}/translations`).
    - Writes: `POST /translatable-items` with a unified `{ project_id, translatable_items: [{ type: 'phrase' | 'content_block', … }] }` body (was the deprecated `POST /projects/{id}/tokens` and `POST /projects/{id}/content-blocks`).
- Missing-phrase registration now chunks into batches of 200 to respect the `/translatable-items` per-request cap.
- Added `LangsysAppAPI.createTranslatableItems()` as the single write entry point for both phrases and content blocks.

## 0.2.0 - 2026-06-10

> Reconstructed retroactively (2026-08-15). This release shipped without a changelog entry, which is how the reversed `t()` signature survived in `CLAUDE.md` for four months — there was no release note to prompt the update. Details recovered from git history (`v0.1.0..v0.2.0`).

### Changed (breaking)

- **`t()` argument order flipped to `t(phrase, category?, params?)`.** 0.1.0 shipped `t(category, phrase, params?)`; the phrase now comes first and the category is optional. Implemented via overloads that discriminate on the type at position 2 (string ⇒ category, object ⇒ params). This is the single most consequential API change in the package's history and the one most likely to be miswritten from memory: with a placeholder-free phrase, the old order still type-checks, silently registering the category as the phrase. Nothing catches it until someone reads the catalog.
- Narrowed `LocaleSource`; extracted the framework-agnostic content-block helpers (`generateCustomId`, `isContentBlockKnown`, `registerContentBlock`, `tokenizeElement`) so non-DOM wrappers can reuse registration without the DOM mutator.
- Missing phrases are sent with a null category on the wire rather than the `__uncategorized__` sentinel, which is server-internal and must not be sent by clients.

### Added

- **`<Phrase>` and `<DontTranslate>`** — markup-sentinel rich-text handling, so a markup-bearing sentence stays one translatable phrase.
- **ICU MessageFormat** wired through `interpolate()`, with the SDK declaring ICU capability so the server sends raw ICU rather than pre-rendered text.

### Fixed

- Content-block dedup unified, and a `custom_id` hash collision fixed. (Note: the deeper `md5` encoding defect behind that class of collision was not found until 0.6.0.)

## 0.1.0 - 2026-05-19

Initial public release. Framework-agnostic TypeScript SDK for the Langsys Translation Manager — the foundation that `langsys-js-svelte` (and future framework-specific bindings) build on.

### Added

- **`t(category, phrase, params?)`** — the everyday translation function. Phrase is both lookup key and base-language default. Curly-brace placeholders are interpolated from `params`.
- **Compile-time-checked interpolation** via template-literal types (`ExtractParamKeys<S>`, `ParamsFor<S>`, `TArgs<P>`). Missing or extra params keys are TypeScript errors at the call site.
- **`tSignal: Signal<TFunction>`** — reactive primitive that re-emits a fresh `t` on every translations/locale change. Framework bindings subscribe to this for re-render invalidation.
- **`Signal<T>`** — minimal subscribe/set/update/get observable with Svelte-store-compatible semantics. Used internally and exposed for consumers.
- **`Translate` DOM class** — wraps an HTMLElement, walks text nodes + translatable attributes (`placeholder`, `alt`, `title`, `aria-label`, `aria-placeholder`, button/input `value`, `<option>` text, several validation `data-*` attrs), registers content blocks with the Translation Manager, re-translates on locale change. `translate="no"` opts elements out.
- **`LangsysApp` singleton** — `init`, `refresh`, `translationsLoadingPromise`, localized list helpers (`getCountries`, `getDialCodes`, `getCurrencies`, `getLocales*`, `getCountryName`, `getCurrencyName`, `getLocaleName`, `getLocaleNameWithLookup`).
- **`LangsysAppAPI`** — direct HTTP access if you want to bypass the rest.
- **SSR support** — `initialTranslations` / `initialTranslationsLocale` to seed pre-fetched data, `ssrTokenStrategy: 'client' | 'server' | 'auto'` to control when missing tokens are flushed.
- **API key permission auto-detection** — read-only keys skip token creation; write keys auto-register new phrases and content blocks.
- **`detectPreferredLocale(acceptLanguageHeader?, supportedLocales?)`** — browser (`navigator.languages`) and SSR (`Accept-Language`) detection with optional locale matching (exact → language-only → null).
- **`persist<T>(key, initial)`** — Signal seeded from localStorage with SSR-safe fallback to in-memory.
- **`interpolate(template, params)`** — exposed for advanced use cases; handles `{name}` placeholders, Date → ISO 8601 serialization.
- **`Logger` / `logger`** — debug-gated console output with styled grouping in browsers, plain output in Node.
- **`md5`**, **`isEmpty`** — utilities used internally, exported for reuse.
- **Vanilla example** in `example/index.html` — single-file demo showing `LangsysApp.init` and `new Translate(...)` with no framework dependencies.

### Notes

- Zero runtime dependencies. Bundled with [tsup](https://tsup.egoel.dev/) as ESM + CJS + `.d.ts`.
- Targets ES2021. Works in modern browsers, Node ≥18, any bundler.
- Build sizes: ~44 KB ESM, ~44 KB CJS, ~16 KB d.ts.

### Provenance

This package replaces the unfinished port of `langsys-js-svelte` that previously occupied this directory. The architecture is new: the proxy-based `_['Cat']['Token']` access pattern from the Svelte SDK was deliberately replaced with the function-call `t('Cat', 'Phrase', params?)` form so interpolation and (future) ICU MessageFormat plurals fit naturally.
