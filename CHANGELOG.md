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
