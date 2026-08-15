## 0.6.0 - 2026-08-14

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

## 0.5.0 - 2026-08-10

### Changed (breaking, types only)

- **`PhraseOptions.params` is now `Record<string, ParamPrimitive>`**, matching `TranslateOptions.params` and `t()`. It was `Record<string, unknown>`, which allowed values — objects, arrays, functions — that interpolation can only render as `[object Object]`. No runtime behavior changes; this is a compile-time narrowing that surfaces those calls as errors instead of silently rendering garbage. `Phrase.setParams()` now also accepts `undefined`, matching `Translate.setParams()`.

  **Impact — two distinct cases.** First, and most visible to application code: **passing an object or array as a param value no longer compiles** (`params={{ user: someObject }}`). That code was already broken at runtime — interpolation could only render it as `[object Object]` — so this converts a silent bug into a build error, but it does bite at build time. Second: code typing its params as `Record<string, unknown>` and forwarding it no longer compiles, which covered all three framework bindings; the fix there is one line per call site, declaring `Record<string, ParamPrimitive>` (exported from the package root). Usefully, that narrowed declaration compiles against 0.4.x *and* 0.5.0, so wrappers can land it independently of the version bump. Runtime is unaffected throughout — code that skips the type change still *works*, it just fails `tsc`.

### Added

- **`Phrase` is documented in the README for the first time.** It's been exported since 0.1.0 but had no section, so the only documented tool for markup-bearing content was `Translate` — which splits at tag boundaries and is the wrong choice for a sentence. The new section covers the three reasons it exists (grammatical agreement, reordering, phrase-key stability), and the `Translate` section now shows the literal per-text-node split so the trade-off is visible at the point of decision.
- Warning against building phrases with template literals (`` t(`Hello, ${name}!`) ``), which registers every runtime value as its own catalog phrase and pollutes the catalog shared across every Langsys SDK.
- Params doc comments now name the `%name%` markup spelling alongside the canonical `{name}`, including Vue's `{{ name }}` case.

## 0.4.3 - 2026-07-08

### Fixed

- **The params diagnostic no longer names the wrong framework.** 0.4.2's warning hardcoded "the framework compiler (Svelte/JSX)" and the `{key}` spelling, which misdiagnoses Vue users — Vue consumes `{{ key }}`, not single braces, so a Vue developer hitting the warning was pointed at a syntax their framework never touches. The message is now framework-neutral and names both brace spellings.

## 0.4.2 - 2026-07-08

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

## 0.2.1 - 2026-06-11

### Changed

- **Migrated off the deprecated API routes onto the current endpoints.** No public API change — the same `t()`, `<Phrase>`, and `<Translate>` usage now talks to:
    - Reads: `GET /translations?project_id=…&locale=…` (was the deprecated `GET /projects/{id}/translations`).
    - Writes: `POST /translatable-items` with a unified `{ project_id, translatable_items: [{ type: 'phrase' | 'content_block', … }] }` body (was the deprecated `POST /projects/{id}/tokens` and `POST /projects/{id}/content-blocks`).
- Missing-phrase registration now chunks into batches of 200 to respect the `/translatable-items` per-request cap.
- Added `LangsysAppAPI.createTranslatableItems()` as the single write entry point for both phrases and content blocks.

## 0.2.0 - 2026-06-05

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
