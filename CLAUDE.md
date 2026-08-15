# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`langsys-js-typescript` is the framework-agnostic TypeScript SDK for the Langsys Translation Manager. It's the **foundation** that framework-specific bindings depend on:

- `langsys-js-svelte` — Svelte 5 binding (lives in a sibling repo)
- Future: React, Vue, Solid, etc. bindings would follow the same pattern

The base SDK owns all the load-bearing concerns: HTTP client, translation catalog, missing-token discovery + flush lifecycle, persistence, SSR strategies, DOM tokenizer, and the reactive `Signal<T>` primitive. Framework wrappers stay thin — ideally <100 lines — because `Signal<T>` was deliberately designed to be Svelte-store-compatible (subscribe-fires-immediately, identical method names) so wrappers are mostly type-relabeling.

## Layout

```
src/
    index.ts                # Public exports — keep this curated; everything consumers touch flows through here
    langsys-app.ts          # LangsysApp singleton — init, refresh, locale switching, country/currency/locale helpers, detectPreferredLocale
    translations.ts         # Translations class — t() implementation, tSignal, missing-token flush lifecycle, content-block lookups
    translate.ts            # Translate DOM class — element wrapper, text/attr tokenization, content-block registration, re-translation on locale change
    api.ts                  # LangsysAppAPI — singleton HTTP client (validate, getTranslations, post/get/delete/patch/put with [projectid] path substitution)
    signal.ts               # Signal<T> + createSignal + getValue
    persist.ts              # persist<T>(key, initial) — Signal backed by localStorage with SSR-safe fallback
    stores.ts               # Module-scoped state: sTranslations (persist), currentlyLoadedLocale, contentBlocks, shared config
    interpolate.ts          # {name}-style + ICU MessageFormat placeholder substitution (CLDR number/date formatting in both paths)
    locale.ts               # canonicalizeLocale (BCP 47 canonical form) + maximizedLangScript (CLDR likely-subtags matching)
    logger.ts               # Logger + logger singleton — debug-gated, styled grouping in browser / plain in Node
    utils.ts                # md5, isEmpty, structuredCloneShim
    types/
        api.ts              # HttpResponse, ResponseObject
        config.ts           # iLangsysInitConfig, iLangsysConfig (uses Signal<string> for UserLocaleStore)
        content-block.ts    # iContentBlock
        countries.ts        # iCountry, iCountryList, iCountryDialCode
        currencies.ts       # iCurrency, iCurrencyList
        locales.ts          # iLocaleFlat, iLocaleData, iLanguageName, iLocaleDefault
        project.ts          # iProject
        translation-fn.ts   # ParamPrimitive, ExtractParamKeys, ParamsFor, TArgs, TFunction, TranslationParams
        translations.ts     # iTranslations (with __category__, __symbol__, __DirectToken__?), iCategories

example/
    index.html              # Single-file vanilla demo — LangsysApp.init + new Translate(...) with no framework
```

## Public API

```typescript
// Singletons + classes
LangsysApp                              // The main entry point
LangsysAppAPI                           // Direct HTTP if you want it
new Translate(element, options)         // DOM wrapper for HTML content blocks
new Translations(config)                // Rarely instantiated directly — LangsysApp owns one

// The translation API
t(phrase, category?, params?)           // Top-level convenience function
LangsysApp.t                            // Same thing, on the singleton
tSignal                                 // Signal<TFunction> — subscribe for reactivity

// Reactive primitive
createSignal<T>(initial): Signal<T>
getValue<T>(signal): T
persist<T>(key, initial): Signal<T>     // localStorage-backed Signal

// Reactive stores (also exported for direct subscription)
sTranslations                           // Signal<iCategories>
currentlyLoadedLocale                   // Signal<string>
contentBlocks                           // Signal<iContentBlock[]>

// Logger
Logger, logger

// Utilities
md5, isEmpty, interpolate

// Types (all the i* + the template-literal type machinery)
```

The full keep-it-curated export list lives in `src/index.ts`.

## How reactivity flows

This is the most subtle part of the architecture — important to understand before touching `translations.ts` or `stores.ts`.

1. The user's locale lives in a `Signal<string>` (`UserLocaleStore`, supplied by the caller).
2. `LangsysApp.init` subscribes to `UserLocaleStore.subscribe()`. Locale changes trigger `Translations.change(locale)`, which fetches the new catalog and sets `sTranslations` + `currentlyLoadedLocale`.
3. `Translations` subscribes to both `sTranslations` and `currentlyLoadedLocale`. On every change, it rebuilds a fresh `TFunction` closure and pushes it through `tSignal.set(newClosure)`.
4. Framework bindings subscribe to `tSignal` (Svelte: `$t`; React: `useT` via `useSyncExternalStore`). The fresh closure reference makes `Object.is` dedup pass — subscribers fire.
5. The closure itself reads `sTranslations.get()` at *call time*, not capture time, so even between rebuilds it returns up-to-date translations.

If templates aren't re-rendering after a locale change, the issue is almost always in step 3 or 4 — not in the consumer code.

## Essential commands

- `npm run build` — tsup builds ESM + CJS + .d.ts to `dist/`. Run after any source change before testing the vanilla example or the Svelte SDK.
- `npm run dev` — tsup in watch mode.
- `npm run typecheck` — `tsc --noEmit`. Should always be clean.
- `npm run prepublishOnly` — runs build (called automatically by `npm publish`).
- `npm run release` — interactive version bump + tag + GitHub release. **Does not publish to npm directly.** See "Releasing" below.

The vanilla `example/index.html` can be opened directly in a browser after a build — it imports from `../dist/index.mjs`. Edit the placeholder `projectid` / `key` to hit the live API.

## Releasing

Publishing to npm is handled by GitHub Actions via [npm Trusted Publishers (OIDC)](https://docs.npmjs.com/trusted-publishers). No long-lived npm tokens or local OTPs are needed.

**Flow:**

1. Commit your changes to `main` — but do **not** push: the script amends the last unpushed commit with the version bump and force-pushes itself, and it errors out if there's nothing unpushed. (Pushed too early? `git commit --amend --no-edit` re-stamps the commit as unpushed.)
2. Run `npm run release` (which calls `_dev_/publish.sh`):
   - Non-interactive: `npm run release -- <version> --yes` skips every prompt and auto-rolls-back on error — use this form when Claude runs the release.
   - Prompts for the new version (suggests next patch).
   - Bumps `package.json`, runs `npm install` + `npm run build` locally as a final sanity check.
   - Amends the last commit with the version bump, force-pushes `main`.
   - Creates and pushes a `v$NEW_VERSION` tag.
   - Creates a GitHub release with auto-generated notes.
   - **Stops there.** Hands off to the Action.
3. **After the Action publishes, stamp the real release date into `CHANGELOG.md`.** Write new sections as `## x.y.z - unreleased` and fill the date from `npm view langsys-js-typescript time --json` once it's live — never from today's date. Six entries were wrong before this rule existed, two by a month, because they were dated from whatever the author believed "today" was rather than from the publish record. A clock is an artifact like any other, and a weaker one than the registry: date a release from the record of the release.
3. The `Publish to npm` workflow (`.github/workflows/publish.yml`) fires on the release event:
   - Job is gated on the `npm-publish` GitHub Environment, which is configured to only allow refs matching `v*`.
   - Runs `npm ci`, `npm run typecheck`, `npm run build`, then `npm publish --provenance`.
   - OIDC short-lived credentials are minted automatically; provenance metadata is attached.

**Wiring requirements (one-time):**

- `package-lock.json` is committed (for `npm ci` reproducibility) — do not re-add it to `.gitignore`.
- `.github/workflows/{ci,publish}.yml` exist and declare `permissions.id-token: write` on the publish job.
- npm's package settings (https://www.npmjs.com/package/langsys-js-typescript/access) have a Trusted Publisher entry: GitHub Actions, org `langsys`, repo `langsys-js-typescript`, workflow `publish.yml`, environment `npm-publish`.
- The GitHub repo has an Environment named `npm-publish` with a deployment-tag restriction of `v*`.

**If a release fails partway:**

`publish.sh` has a rollback path that resets the amended commit + force-pushes back, deletes the local + remote tag, and reverts `package.json`. It will offer to run it on error. If the npm publish step itself fails (e.g., transient OIDC trust mismatch), the GitHub release and tag still exist — re-running the workflow from the Actions tab is usually enough; otherwise delete the release + tag, fix the issue, and try again.

**CI workflow (`ci.yml`):**

Runs on every push to `main` and every PR. `npm ci` → `npm run typecheck` → `npm run build`. Failures here block merges.

## Design invariants

Things to preserve when making changes:

1. **One runtime dependency: `intl-messageformat`.** The whole point of being framework-agnostic is to drop in anywhere without dragging in baggage — any additional dep needs a strong justification. Locale plumbing (canonicalization, likely-subtags matching, number/date formatting) rides on the platform's native `Intl` APIs, never bundled CLDR data.

1a. **Locale identifiers are BCP 47 canonical everywhere.** `canonicalizeLocale` runs at every input boundary (init config, user-locale store emissions, `detectPreferredLocale`, API params); cache keys, equality checks, and wire values all use the canonical form (`en-US`, `zh-Hant-TW`). Don't add locale-string comparisons that bypass it.

2. **`Signal<T>` stays Svelte-store-compatible.** `subscribe(run)` must fire immediately with the current value; `set/update/get` keep their current shapes. The Svelte binding relies on this structural compatibility.

3. **`t()` closures read fresh state.** Don't capture `sTranslations.get()` at closure-build time — read it on every call. Otherwise the closure goes stale between rebuilds.

4. **Missing-token registration is `t()`'s responsibility.** Lookup misses in `t()` (and the `Translate` DOM class for content-block tokens) feed `Translations.missingToken`. Don't add separate paths that bypass this.

5. **`Translate` is the only DOM-touching code.** Everything else must work in Node. Keep the platform fork narrow.

6. **SSR strategies are config-driven.** Don't bake assumptions about server vs. client into the lifecycle code beyond the `typeof window === 'undefined'` checks and `ssrTokenStrategy` switches.

7. **Template-literal types stay opt-in via generics.** `<P extends string>(phrase: P, category?: string, ...args: TArgs<P>)` — phrase FIRST, category optional and second. Don't widen the signature to `string` in a way that defeats compile-time placeholder checking, and don't reverse the argument order: with a placeholder-free phrase, `t(category, phrase)` type-checks cleanly and silently registers the category as the phrase.

## Build / output

`tsup` produces:
- `dist/index.js` (CJS)
- `dist/index.mjs` (ESM)
- `dist/index.d.ts` + `dist/index.d.mts` (types)
- `.map` files for both

Target: ES2021. Module resolution: bundler. Strict TypeScript with `verbatimModuleSyntax: true`.

## Testing approach

No formal test suite yet. Adding unit tests for `interpolate`, `Signal`, `persist`, and `Translations.t` lookup behavior is a good next step. Integration testing currently happens by hand via `example/index.html` or by exercising the file:..-linked Svelte SDK.
