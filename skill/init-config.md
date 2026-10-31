# `init()` and configuration

```ts
import { LangsysApp, createSignal } from 'langsys-js-typescript';

const userLocale = createSignal('en-us');

const res = await LangsysApp.init({
    projectid: process.env.LANGSYS_PROJECT_ID!,
    key: process.env.LANGSYS_API_KEY!,
    UserLocaleStore: userLocale,
    baseLocale: 'en-us',
    debug: process.env.NODE_ENV !== 'production',
});

if (!res.status) console.error('Langsys init failed', res.errors);
```

Call it once, before anything translates. It resolves an `iLangsysResponse`: `status`, and `errors` when it fails. **Always check `status`.** A wrong key, a wrong host or an unreachable server throws nothing. It shows only there and as a `Langsys` warning or error in the console.

## Fields (`iLangsysInitConfig`)

| Field | Type | Default | What it does |
|---|---|---|---|
| `projectid` | `string` | none | Project id from Langsys. Without it the core is unconfigured (below) |
| `key` | `string` | none | API key. Without it the core is unconfigured |
| `UserLocaleStore` | `LocaleSource` | none | The user's chosen locale: anything with `get()` and `subscribe(run)`, where `subscribe` calls `run` at once with the current value. The first catalog is fetched from that call, so a store that only reports changes never loads one |
| `baseLocale` | `string` | `'en'` | The language your source phrases are written in |
| `debug` | `boolean` | `false` | Console diagnostics, including the unmatched-params warning. Off in production |
| `apiUrl` | `string` | `https://api.langsys.dev/api` | Another API host: local, staging, a test double |
| `requireCredentials` | `boolean` | `false` | Throw instead of rendering source text when unconfigured |
| `writeGrant` | `WriteGrant` | none | A function returning a short-lived grant token or `null`, or a token string ([writing.md](./writing.md)) |
| `ssrTokenStrategy` | `'client' \| 'server' \| 'auto'` | `'client'` | Where a server render's misses are sent from ([server-rendering.md](./server-rendering.md)) |
| `initialTranslations` | `iCategories` | none | A catalog fetched on the server, to skip the client's fetch on hydration |
| `initialTranslationsLocale` | `string` | none | The locale `initialTranslations` holds. Pass both or neither |
| `legacyKeys` | `LegacyKeyFile[]` | none | Keep i18next or vue-i18n key files during a migration ([migration.md](./migration.md)) |
| `messagesCategory` | `string` | `'Errors'` | The category server message templates use ([catalog.md](./catalog.md)) |
| `emulateFailureToLoad` | `boolean` | `false` | Test hook: the catalog load fails |

Locales passed in any form are canonicalized where they enter (`en-US` becomes `en-us`, [locales.md](./locales.md)).

## Another API host: `apiUrl`

```ts
await LangsysApp.init({ projectid, key, UserLocaleStore, apiUrl: 'http://localhost:8000/api' });
```

Use `apiUrl` rather than `LangsysAppAPI.setBaseUrl()`, which must run **before** `init()`. Called after, it leaves the SDK permanently inert. `init()` has already authorized against the default host and failed, and the locale subscription is closed over that result, so it no-ops for the life of the app. Nothing throws. `apiUrl` is applied inside `init()`, before it authorizes.

## No credentials: the unconfigured core

`init()` without a project id, an API key or a locale store doesn't throw. It resolves `{ status: false, errors }` and leaves the client **unconfigured**, so a preview build or a test run without secrets still renders.

- `t()` shows the source text with its params filled, and makes no request.
- A block's registration resolves skipped, `not-configured`.
- **An explicit write throws** (`LangsysAppAPI.post`, `put`, `patch`, `delete` and `LangsysAppAPI.createTranslatableItems`): each rejects with `LangsysConfigurationError`.
- The reference lists answer empty lists without a request, and `LangsysApp.getLocaleName` answers `''`.
- A refused `init()` forgets credentials an earlier `init()` accepted.
- One `Langsys` console error says the core is unconfigured. `LangsysApp.isConfigured()` reports the state.

With `requireCredentials: true` it fails loudly instead:
- `t()` throws `LangsysConfigurationError`.
- `Phrase` and `Translate` still construct, but their render rejects with that error, as does `registerBlock`'s promise.
- Every reference list rejects, and `getLocaleName`, which is synchronous, throws.

It fails on the first `t()`, registration or reference read, so content that only renders never fails: a block with `register: false`, or one rendered with `renderBlock` and never registered.

## After `init()`

| Call | What it does |
|---|---|
| `LangsysApp.t` | The current `TFunction`, a getter that reads fresh state on every call. Same as the top-level `t` |
| `LangsysApp.refresh()` | Fetch the current locale's catalog again |
| `LangsysApp.isConfigured()` | Whether `init()` accepted a project id, a key and a locale store |
| `setWriteGrant(grant)` | Supply or replace the write grant; the session re-authorizes ([writing.md](./writing.md)) |
| `notifyNavigation()` | After a client-side route change ([writing.md](./writing.md)) |
| `localeHeaders()` | `{ 'Accept-Language': … }` for your own API calls ([locales.md](./locales.md)) |
| `LangsysApp.seedCatalog()` / `LangsysApp.loadSnapshot()` | Put a catalog in place synchronously, before mount ([catalog.md](./catalog.md)) |
| `LangsysApp.translationsLoadingPromise` | Settles when a locale change is **no longer in flight**. See below |

Change the locale by setting your store: `userLocale.set('es-es')`. The SDK fetches that catalog, and everything bound to `tSignal` re-renders.

**`translationsLoadingPromise` is not a success signal.** It is already resolved before `init()`, it resolves when a catalog fetch fails, and it resolves at once when the store re-emits the locale already loaded within the last minute, or a recent failure is still inside its retry window. Treat it as "the change is no longer in flight". After `await LangsysApp.init(...)` it is the first catalog's attempt, which makes it a reasonable gate against a flash of source text, never proof that translations arrived. A missing catalog renders the base language, which is a safe fallback, so don't build retries or error states on this promise.

## The signals a binding is built on

Every binding is a thin layer over these:

```ts
import { currentlyLoadedLocale, sTranslations, tSignal } from 'langsys-js-typescript';

const unsubscribe = tSignal.subscribe((t) => {
    document.querySelector('h1')!.textContent = t('Welcome', 'Home');
});
```

- **`tSignal`** re-emits a fresh `TFunction` on every catalog or locale change. Subscribe for invalidation and call the function for values; that is the whole of a framework binding.
- **`currentlyLoadedLocale`** is the locale whose catalog is loaded; **`sTranslations`** is the catalog itself.
- **`writeEnabled`** and **`autoDiscovery`** are the server's write decision and the key's discovery policy ([writing.md](./writing.md)).

A `Signal<T>` has `subscribe(run)`, which calls `run` at once with the current value and returns an unsubscribe function, plus `set(v)`, `update(fn)` and `get()`. That is Svelte's store contract plus `.get()`. `createSignal(initial)` makes one, `getValue(signal)` reads one, and `persist(key, initial)` makes one backed by `localStorage` that falls back safely on a server. A framework subscribes to `tSignal` as it would to any external store, and reads `tSignal.get()` for the current function.

## Hosts with no `localStorage` or `document`

- `setPersistStorage(storage)` supplies a synchronous storage (`getItem`, `setItem`, optional `removeItem`) for the catalog cache, such as MMKV or an in-memory mirror of AsyncStorage on React Native.
- `setTeardownSignal(subscribe)` supplies the "app is going away" signal: `subscribe(fire)` returns an unsubscribe, and the SDK flushes what is queued when `fire` is called.

## Diagnostics

`debug: true` logs the SDK's decisions. Warnings and errors print whatever `debug` is set to, under a `Langsys` label. A catalog request for a locale the project doesn't have answers 422, and the server's message, such as `The locale provided is not a base or target locale for this project`, is in that log. Search the console for `Langsys` before concluding there is no diagnostic.
