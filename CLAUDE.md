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
    stores.ts               # Module-scoped state: sTranslations (persist), currentlyLoadedLocale, writeEnabled, autoDiscovery, batchLimit, shared config
    interpolate.ts          # {name}-style + ICU MessageFormat placeholder substitution (CLDR number/date formatting in both paths)
    locale.ts               # canonicalizeLocale (lowercase xx-yy form) + maximizedLangScript (CLDR likely-subtags matching)
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
writeEnabled                            // Signal<boolean | undefined> — server-computed write capability
autoDiscovery                           // Signal<boolean | undefined> — per-key reporting policy

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

1. Commit your changes to `main` — but do **not** push: the script amends the last unpushed commit with the version bump and force-pushes itself, and it errors out if there's nothing unpushed. (Pushed too early? Add a new commit — `git commit --allow-empty -m "chore: prepare release"` — and let the script amend *that*. **Do not** `git commit --amend --no-edit` to re-stamp the pushed commit: since 0.6.5 the script's divergence guard correctly refuses that state, and rebasing as it instructs simply undoes the amend. That advice only ever worked by exploiting the force-push hole the guard now closes — it rewrites already-published history and orphans any tag pointing at it.)
2. Run `npm run release` (which calls `_dev_/publish.sh`):
   - Non-interactive: `npm run release -- <version> --yes` skips every prompt and auto-rolls-back on error — use this form when Claude runs the release.
   - Prompts for the new version (suggests next patch).
   - Bumps `package.json`, runs `npm install` + `npm run build` locally as a final sanity check.
   - Amends the last commit with the version bump, force-pushes `main`.
   - Creates and pushes a `v$NEW_VERSION` tag.
   - Creates a GitHub release with auto-generated notes.
   - **Stops there.** Hands off to the Action.
3. **Changelog dates are stamped by the release script, then verified.** Write new sections as `## x.y.z - unreleased`; `publish.sh` fills the date in at release time, seconds before publish, so the shipped tarball carries a real date instead of the word "unreleased". After the Action completes, verify with `npm view langsys-js-typescript time --json` and correct if they disagree.

   Never date a heading when you *write* it. Six entries were wrong before this rule, two by a month, because a heading typed days before release records when it was typed, not when it shipped. Release-time and publish-time agree to the second; authoring-time doesn't. The registry is the check, not the source — a check nobody runs is how all six survived.
4. The `Publish to npm` workflow (`.github/workflows/publish.yml`) fires on the release event:
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

## Commit conventions

Commit messages carry **no trailers** — no `Co-Authored-By`, no `Claude-Session`, no agent
attribution of any kind. Fleet convention across every Langsys SDK repo, and the operator's
standing instruction here. Credit humans in the message body where they found something
(see the ticket-838 fold commits); that is different from a machine trailer.

## Design invariants

Things to preserve when making changes:

1. **One runtime dependency: `intl-messageformat`.** The whole point of being framework-agnostic is to drop in anywhere without dragging in baggage — any additional dep needs a strong justification. Locale plumbing (canonicalization, likely-subtags matching, number/date formatting) rides on the platform's native `Intl` APIs, never bundled CLDR data.

1a. **Locale identifiers are lowercase `xx-yy` everywhere.** `canonicalizeLocale` runs at every input boundary (init config, user-locale store emissions, `detectPreferredLocale`, API params); cache keys, equality checks, and wire values all use the lowercase form (`en-us`, `zh-hant-tw`). Don't add locale-string comparisons that bypass it.

    This was BCP 47 canonical casing until spec v8, and it deliberately supersedes that. Lowercase is what every locale in the backend's database already is — script subtags included, stored `az-cyrl`/`bs-latn` — and what its request middleware produces, so it is the only form guaranteed to behave identically on a route that doesn't mount that middleware; the routes most likely to miss it are the legacy ones carrying the oldest clients. CLDR handling is unaffected: `Intl` canonicalises its own input, so `new Intl.Locale('zh-tw').maximize()` still yields `zh-Hant-TW`.

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

`npm test` runs vitest over `tests/` — 17 files, 268 tests (`api`, `api-reachability`, `content-block-identity`, `custom-id`, `custom-id-cross-impl`, `discovery`, `grant-lane`, `init-settle`, `interpolate`, `langsys-app`, `locale`, `logger`, `persist`, `richtext`, `translate`, `translations`, `write-lane`).

`content-block-identity` pins `custom_id` **identity** rather than output: text-node arity, comment skipping, and attribute emission order. Those are wire values shared with every other SDK. It is mutation-checked — adding `clone.normalize()` to `tokenizeElement` turns three of its tests red. It also pins the **opposite** rule on the `<Phrase>` path: `encodeRichText` coalesces adjacent text nodes by design, because the phrase string is the key and a sentence must survive whole. The two paths are not meant to agree — the realistic bug is someone applying the content-block contract to `richtext.ts`. A failure there is a breaking change, not a stale expectation; never repin a literal to make it green. `npm run test:watch` for watch mode.

**Cross-SDK behaviour is verified against langsys-php's fixtures, not re-derived here.** `langsys-php/tests/fixtures/` holds the shared contract — `custom-id-reference.json` (13 cases), `tokenizer-reference.json` (17), `interpolation-reference.json` (19). `custom-id-reference.json` is now vendored into `tests/fixtures/` and asserted every run by `custom-id-cross-impl` (see CONFORMANCE CID-1); the other two are not yet. Re-vendor on a deliberate bump, citing the source SHA — never edit the vendored copy. Execute the *published tarball* against all three after a release; re-deriving expected values in TypeScript proves nothing, since both sides would share the same mistake. Adding cases is safe; changing an existing expectation is a breaking change to content-block identity in every SDK and goes to the PHP agent first.

Integration testing still happens by hand via `example/index.html` or by exercising the file:..-linked Svelte SDK.
