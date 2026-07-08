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
