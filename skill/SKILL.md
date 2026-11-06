---
name: langsys-typescript
description: The Langsys TypeScript core skill, for langsys-js-typescript and every Langsys JavaScript binding built on it. Part of the Langsys skill set, read in order - the entry skill langsys first, then this one, then the framework's own skill (langsys-svelte, langsys-react, langsys-vue and the rest). Covers t(), Phrase and Translate, the write signals and grants, init and config, interpolation and plurals, value markers, legacy keys and snapshots, reference lists, localeHeaders, catalog caching and request scopes for server rendering.
metadata:
  package: langsys-js-typescript
  version: 0.7.2
---

# Langsys TypeScript core

<!-- langsys-skill-preamble:start -->
**This skill is one part of the Langsys skill set.** Read the set in this order, and never skip a step:

1. **`langsys`**, the entry skill: what Langsys is, choosing the SDKs, the project, API keys and secrets, and the rules every Langsys SDK shares.
2. **The core skill of the SDK's language**: `langsys-typescript` for JavaScript and TypeScript, `langsys-php` for PHP. It holds what is true for every framework in that language.
3. **The framework's own skill**, such as `langsys-svelte` or `langsys-laravel`. It adds only what its framework changes.

The entry skill isn't installed with any SDK. If `langsys` isn't among your skills, read it at https://docs.langsys.dev/skill/langsys/. If you can't reach that page, tell the user to run `npx langsys-skill install`, which installs it with the skill of every Langsys package in the project.
<!-- langsys-skill-preamble:end -->

This is `langsys-typescript`, step 2 for JavaScript and TypeScript. It describes `langsys-js-typescript` at the version in its frontmatter. Check the installed version first (`npm ls langsys-js-typescript`). If it differs, say so before relying on anything here.

`langsys-js-typescript` is the framework-agnostic core of every Langsys JavaScript SDK: the HTTP client, the translation catalog, phrase discovery and registration, the DOM tokenizer, server-render scopes and the `Signal<T>` primitive. A binding's skill (`langsys-svelte`, `langsys-react`, …) reads this one first and adds only what its framework changes. Where a binding forwards a core call, the behaviour is the one described here. The examples are plain TypeScript.

## The model

- **The source text is the key.** There are no catalog files and no message ids: `t('Save', 'UI')` looks up the phrase `Save` and renders it as-is until a translation exists.
- **Content is discovered as the app runs.** A session the server makes write-enabled registers each phrase and content block it misses, and the Translation Manager fills in the translations.
- **The catalog is fetched per project and locale**, held in memory and cached in the browser.
- **Untranslated text renders as its source**, so the base language always reads as written, and gains its plural forms once Langsys has checked the phrase. That is why most mistakes here are invisible: they show only when someone switches locale or reads what was registered in the Translation Manager.

## The rules that matter most

1. **Never build a phrase.** `` t(`Hello, ${name}!`) `` registers one phrase per distinct value, permanently, in a catalog every SDK on the project shares. Pass values as params: `t('Hello, {name}!', 'Greetings', { name })`. [invariants.md](./invariants.md)
2. **Never write ICU.** Write the sentence flat, `t('You have {count} new messages', 'Inbox', { count })`, and Langsys makes each language's plural and gender forms, your base language's included: English renders `You have 1 new message` with no ICU in your code. A sentence that says something different at zero is its own phrase. [interpolation.md](./interpolation.md)
3. **Phrase first, category second.** `t(phrase, category?, params?)`. With a placeholder-free phrase both orders typecheck, so the compiler won't catch a swap.
4. **Choose the primitive by asking whether a tag boundary belongs to the language or to the layout.** Plain text is `t()`. One sentence with inline markup is `Phrase`. A block of separate units is `Translate`. [primitives.md](./primitives.md)
5. **The server decides whether a session may register, not the key's type.** An answer without `write_enabled: true` is read-only, even for a `write` key. The entry skill holds the concept; [writing.md](./writing.md) has how the SDK exposes it.
6. **Locale identifiers are lowercase `xx-yy`** everywhere the SDK hands one back (`en-us`, `zh-hant-tw`). Compare in that form. [locales.md](./locales.md)
7. **Check what `LangsysApp.init()` returns.** A refused authorization doesn't throw. It shows only in what `init()` resolves and as a `Langsys` line in the console. [init-config.md](./init-config.md)

## Where to read

| Read | When |
|---|---|
| [primitives.md](./primitives.md) | Before marking any content: `t()`, `Phrase`, `Translate`, opting out |
| [invariants.md](./invariants.md) | Before writing code: the rules other i18n habits break |
| [writing.md](./writing.md) | Phrases aren't registering: `writeEnabled`, write grants, page reports, `notifyNavigation()`, registration results |
| [init-config.md](./init-config.md) | Wiring `init()`, an unconfigured core, the signals bindings build on |
| [interpolation.md](./interpolation.md) | Placeholders, `{name}` against `%name%`, plurals and gender written flat, rendering ICU, the template tag |
| [value-markers.md](./value-markers.md) | HTML another renderer printed values into; placeholder names |
| [migration.md](./migration.md) | Moving off i18next or vue-i18n keys; catalog snapshots |
| [locales.md](./locales.md) | Canonical locales, `LangsysApp.detectPreferredLocale`, `localeHeaders()`, the country, currency and locale lists |
| [catalog.md](./catalog.md) | How the catalog is fetched, cached and seeded; server messages |
| [server-rendering.md](./server-rendering.md) | Rendering on a server: request scopes, content blocks without a DOM, the `/pure` subpath |

## Entry points

| Import | Holds |
|---|---|
| `langsys-js-typescript` | `LangsysApp`, `t`, `tSignal`, `Translate`, `Phrase`, request scopes, block trees, signals, and most of what `/pure` holds |
| `langsys-js-typescript/pure` | The rules with no DOM and no network: ids, tokenizer rules, locales, interpolation, legacy keys, snapshots, server messages ([server-rendering.md](./server-rendering.md)). A few exist only here: `TRANSLATABLE_ATTRIBUTES`, `NON_TRANSLATABLE_ELEMENTS`, `encodeRichPhrase`, `canonicalContentBlockJson`, `maximizedLangScript`, `normalizeTokenText`, `stripC0Controls` |
| `langsys-js-typescript/browser` | The same as the main entry with its one dependency inlined: the self-contained browser build |

The one runtime dependency is `intl-messageformat`. The main entry leaves it external so a bundler dedupes it. Don't load `dist/index.mjs` directly in a browser: its bare `intl-messageformat` import doesn't resolve, and the module silently never runs. A page with no bundler can't resolve a package name either, so it imports the browser build by its file, `./node_modules/langsys-js-typescript/dist/langsys.browser.mjs`, or loads `dist/langsys.browser.global.js` for a `Langsys` global.
