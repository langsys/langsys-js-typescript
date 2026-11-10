# The catalog: fetching, caching, seeding, server messages

## What the catalog is

The catalog is a project's translations for one locale, by category: `{ [category]: { [phrase]: translation } }` (`iCategories`). `t()` reads it on every call, and `sTranslations` holds it as a signal. A phrase or block missing from it renders its source text and, in a write-enabled session, is registered ([writing.md](./writing.md)).

## Fetching

- **One catalog per project and locale.** A locale that is neither the project's base nor one of its targets answers 422, and the server's message is in the `Langsys` console log.
- **The locale store drives it.** Each locale the store emits fetches that locale's catalog, unless the store is re-emitting the locale already loaded within the last minute. A switch away and back fetches again. `LangsysApp.refresh()` fetches again regardless.
- **Concurrent requests share one fetch.** Every catalog answer also carries the session's `write_enabled`.
- **A failed fetch renders source text and isn't repeated on every emission.** That project and locale aren't fetched again until a failure window passes: 3 seconds, doubling up to 5 minutes. `refresh()` is a deliberate request and still goes out. A catalog already in hand keeps serving while a fetch or an authorization is refused.

## The browser cache

In a browser the catalog is cached in `localStorage` under its project and locale, as `langsys:translations:<projectid>:<locale>`. A reload renders that catalog while `LangsysApp.init()` authorizes, and the fetched catalog then replaces it. So a page never shows another project's or locale's cached text, and a catalog seeded for one locale is never cached as another's. The cache holds translations only; whether the session may write is asked of the server every time. Where there is no `localStorage`, `setPersistStorage(storage)` supplies a synchronous one ([init-config.md](./init-config.md)).

## Putting a catalog in place before the first render

The first paint can carry translations without waiting for a fetch:

| Way | When |
|---|---|
| `initialTranslations` + `initialTranslationsLocale` in `init()` | The server fetched the catalog. Skips the client's fetch on hydration. Pass both or neither |
| `LangsysApp.seedCatalog(catalog, locale, seed?)` | Synchronous, before `init()` and before the DOM classes mount: hydrating a server render, with the request scope's seed ([server-rendering.md](./server-rendering.md)) |
| `LangsysApp.loadSnapshot(snapshot, locale?)` | An exported catalog file: a bundle, an offline session ([migration.md](./migration.md)) |

With each, `init()` still authorizes. `initialTranslations` counts as the locale's loaded catalog, so the client doesn't fetch it. After `seedCatalog()` or `loadSnapshot()` the client may still fetch the live catalog, which then replaces what was put in place. Either way the first paint shows the seeded text.

## Server messages

A Langsys server SDK leaves your framework's error response as it is, and attaches translatable entries beside it (Laravel puts them under `langsys_errors`, next to its own `message` and `errors`). An entry holds:
- `template`: the framework's own sentence, with the field's label written in and `{name}` markers for values;
- `params`: the values that fill it;
- `message`: the sentence already filled, in the source language;
- `field` and `code`: the framework's own, passed through unchanged.

```ts
import { renderServerMessage, resolveServerMessages } from 'langsys-js-typescript';

const res = await fetch('/api/signup', { method: 'POST', body });
if (!res.ok) {
    for (const entry of resolveServerMessages(await res.json(), { key: 'langsys_errors' })) {
        showError(entry.field, renderServerMessage(entry));
    }
}
```

- **`resolveServerMessages(body, { key })`** reads the entries at the path your server attaches them under, the same setting as the server's. Nothing else in the body is read or changed.
  - Other piece names map with `pieces: { template: 'sentence', … }`.
  - `{ resolver }` builds the entries yourself.
  - With neither `key` nor `resolver` it throws: it has nowhere to look.
- **`renderServerMessage(entry, category?)`** renders the `template` through `t()`, filled from `params`, in the current locale. With no translation it shows `message`, the framework's own text. An entry with no `template` shows its `message` and isn't looked up. A count param drives an ICU plural in the translation with no ICU in your code.
- **Branch on `code`, never on the text.** It's the framework's identifier, so it holds whatever language the text is in.
- **The category is `Errors`.** If your server registers templates under another, set the same one with `messagesCategory` in `init()`, or every lookup misses.
- **A renamed category names the old one.** Set `messagesPreviousCategory` in `init()` to the category the templates were registered under before (`''` for none), the same as the server's. A template not yet translated under `messagesCategory` renders the old category's translation, before falling back to `message`, and its registration carries the move. Whether a template is registered is still decided under `messagesCategory` alone, and once the catalog has their translations there the option has no effect.

`resolveServerMessages`, `toServerMessage`, `templateMarkers` and `fillTemplate` are on `langsys-js-typescript/pure` too, with no DOM.
