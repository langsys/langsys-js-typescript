# Rendering on a server

A server process renders for many visitors at once, and the SDK's catalog, locale and miss queue are module state. A module-wide locale store is therefore unsound for concurrent requests. So each request renders inside a **request scope** of its own: its own locale, its own view of the catalog, its own misses and its own hydration seed. Nothing one scope does reaches another. A binding wires scopes into its framework's request hook; this file is what it wires.

## A request scope

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequestScope, setRequestScopeStorage } from 'langsys-js-typescript';

setRequestScopeStorage(new AsyncLocalStorage());           // once, at startup

// per request, in the host's request hook:
const scope = await createRequestScope({ locale: resolvedLocale, url: request.url });
const html = await scope.run(() => renderApp());            // t(), Translate and Phrase resolve to the scope
const seed = scope.seed();                                  // serialize into the page for the client
// ...send the response, then:
await scope.close();                                        // sends what the render missed, after the response
```

- **`createRequestScope({ locale, catalog?, url?, credentials? })`** resolves once the scope's catalog is in hand: the `catalog` you pass, or a fetch. A fetch is made at most once per request, and shared read-only for a minute with scopes rendering the same locale under the same credentials. A failed fetch renders source text and records nothing. Resolve `locale` from the request (`LangsysApp.detectPreferredLocale(header, supported)`, [locales.md](./locales.md)).
- **`scope.run(fn)`** makes the scope current while `fn` runs, for `t()`, `currentlyLoadedLocale.get()` and `sTranslations.get()` alike, and returns what `fn` returns, a promise included. Without `setRequestScopeStorage`, only code that finishes synchronously inside `fn` sees the scope.
- **Use `scope.t` in anything that may run later, never `tSignal.get()`.** The `t` that `tSignal.get()` returns inside `run()` reads the catalog when it's called, so a component that calls it later, outside `run()`, reads the page's catalog. `scope.t` is the scope's wherever it's called. `scope.locale` is its locale.
- **`scope.enter()`** makes the scope current for the rest of the current async context, for a host that can't wrap its render in a function. It holds only in the continuation that performs the render: called inside a function the host awaits and returns from, the scope is gone when that function returns. Call `enter()` in the function that renders, and `run()` everywhere else. It needs the storage, and throws without it.
- **`setRequestScopeStorage(storage)`** is opt-in, and what it guarantees depends on the host's async model. Under zone.js, for one, promises don't carry it across concurrent renders. A host can instead carry the scope through its own dependency injection and use `scope.t` directly.
- **`scope.close()`** runs after the response and never throws. It sends the scope's misses when the scope's key may write and the strategy collects on the server, and otherwise leaves them to the client. It resolves a `RegistrationResult` naming what happened ([writing.md](./writing.md)). `scope.misses()` lists the phrases the render missed.
- **`currentRequestScope()`** returns the scope the current code runs in, or `undefined`.

### More than one project in one process: `credentials`

`credentials: { projectid, key, writeGrant? }` gives a scope its own project and key. The scope's catalog fetch and its `close()` go out under them. So does every request its render makes, however renders interleave, once `setRequestScopeStorage` holds an `AsyncLocalStorage`. Without one, only requests made before the render's first `await` see the scope; pass `{ credentials }` to a `LangsysAppAPI` call you make later.

- **Without `credentials`** the scope sends under the credentials `init()` set, and the page's own requests always do.
- **No `init()` credentials needed:** a process can call `init()` without them and give every scope its own; `apiUrl` and `ssrTokenStrategy` still apply.
- **The scope's write capability is its key's**, as its catalog fetch reports it. So a scope given both a `catalog` and credentials has no answer for its key. Where the strategy collects on the server, its `close()` resolves `not-write-enabled`. Under `'client'` it resolves `client-strategy` first.
- **A project id and a key are both required,** or `createRequestScope` rejects with `LangsysConfigurationError`. Credentials are never part of `seed()`.

## Where a server render's misses go: `ssrTokenStrategy`

| Value | Misses found during a server render |
|---|---|
| `'client'` (default) | Left to the client, which registers them after hydration |
| `'server'` | Sent from the server at `close()` |
| `'auto'` | In a request scope: sent from the server at `close()` when the render missed fewer than 5, and otherwise all left to the client. Rendering without a scope: the first 5 are sent from the server, and the rest are left to the client |

- **`'server'` (and the server half of `'auto'`) only works if the server's own address is on the key's allow-list.** Registration from a render is sent from your server, and the write decision is computed for that address. Off the allow-list, the server lane is read-only and fails silently: no error, no request, nothing in the catalog. No discovery report either, since nothing is reported from a server render.
- **Content that exists only on the server is registered by neither `'client'` nor the browser**, which never walks markup it didn't render. For that, use `'server'` with an allow-listed address.
- **While a write grant is configured, the strategy acts as `'client'`.**
- On a server, `writeEnabled` stays `undefined`. Never branch on it there.

## Hydrating on the client

Serialize `scope.seed()` into the page: `{ locale, catalog, blocks, phrases }`. On the client, put it in place before the DOM classes mount, then register each block after `init()`:

```ts
LangsysApp.seedCatalog(seed.catalog, seed.locale, seed);   // synchronous, before mount
await LangsysApp.init({ projectid, key, UserLocaleStore });
for (const block of Object.values(seed.blocks)) registerBlock(block);   // skips what the server collected
```

The seed's blocks give each served block's source tokens. Blocks and phrases the server sent itself at `close()` are marked `collected`, and the client never registers those.

`scopeFromSeed(seed)` rebuilds the server's scope on the client, synchronously, from the seed the page carries. It's for a hydration render that must read exactly what the server read, in code that can't await. It sends nothing itself; its render's misses and blocks go to the page, which skips what the server collected.

A `Translate` over a host the server stamped and resolved takes the block's source tokens from the seed, or without one from the catalog entry the served text was rendered from. A `Phrase` over a resolved host takes its source phrase the same way. Neither reads the source from the DOM, so a later locale switch renders that locale. A host whose source can't be recovered keeps the text it was served with, and the core warns once.

## Content blocks without a DOM

A server render, or a client render before mount, has no DOM for `Translate` to walk, and inside a request scope that class does nothing. Render the block from its content as a tree instead:

```ts
import { registerBlock, renderBlock } from 'langsys-js-typescript';

const content = [
    { tag: 'p', children: [{ text: 'Compare every plan' }] },
    { tag: 'p', children: [{ text: 'Cancel anytime' }] },
];
const { nodes, hostAttrs } = renderBlock(content, { category: 'Pricing' });   // synchronous, registers nothing
registerBlock(content, { category: 'Pricing' });                               // inside a scope: sent at close()
```

- **A `BlockNode`** is `{ text }`, `{ comment }` (value markers: [value-markers.md](./value-markers.md)), or `{ tag, attrs?, children?, params? }`. A nested host's element can carry `params` of its own, so each unit names its values: `{ tag: 'span', attrs: { 'data-ls-phrase': true }, params: { name }, children }`.
- **`renderBlock(nodes, options?)`** returns the translated tree, `customId`, and `hostAttrs` to set on the host element: `data-ls-contentblock` for a block with content, and `data-ls-resolved` when the text came from the catalog in a non-base locale. Each rendered element names its input element by `source` (its pre-order index), so a binding can re-attach handlers even where a translation reorders inline markup.
- **Its options** (`BlockOptions`) are `category`, `params`, `label`, `register`, `id`, `customId` and `host`, the DOM element the tree came from, when there is one. `id` registers under your own `custom_id`; `customId` adopts a stamp the server rendered from the catalog.
- **`registerBlock(nodesOrSeededBlock, options?)`** registers as `Translate` does on the page. On a server it registers only inside a request scope: outside one there is no scope to hold the block for `close()`, so it registers nothing, resolves at once, and says so in one debug notice.
- **On the client,** `applyRendered(element, rendered)` writes a rendered block into the existing nodes in place: text, translatable attributes and nested hosts' markers. It refuses with `reason: 'structure'` when the markup's shape differs. Pass `{ self: true }` when the tree was rendered from the host element itself rather than its children, as a standalone phrase host is.
- **The tree helpers:** `blockNodesOf(element)` turns a DOM host's content into a tree, `tokenizeTree(nodes)` gives a tree's tokens, and `serializeTree(nodes)` its markup.

## The `/pure` subpath: the rules with no DOM

`langsys-js-typescript/pure` holds the rules that decide what's stored and how it renders. Nothing it exports reads `window`, `document`, `navigator` or storage, at import or on any call, and importing it has no side effects. A worker, an edge runtime or a build script derives the same ids, keys and output the browser does:

```ts
import { canonicalizeLocale, generateCustomId, interpolate } from 'langsys-js-typescript/pure';

canonicalizeLocale('zh-Hant-TW');                                          // 'zh-hant-tw'
generateCustomId('Pricing', ['Compare every plan', 'Cancel anytime']);     // the block's custom_id
interpolate(translation, { count: 3 }, 'ru-ru');                           // a catalog's Russian plural, in its form for 3
```

What it holds:

- **Ids and keys:** `generateCustomId`, `canonicalContentBlockJson`, `encodeRichPhrase`, `md5`.
- **The tokenizer's rules:** `TRANSLATABLE_ATTRIBUTES` and `NON_TRANSLATABLE_ELEMENTS`.
- **The marker attributes:** `PHRASE_MARKER_ATTR`, `CONTENT_BLOCK_MARKER_ATTR`, `RESOLVED_MARKER_ATTR` and their `*_LEGACY` and `*_ATTRS` forms, and `VAR_PARAM_ATTR`.
- **Locales:** `canonicalizeLocale`.
- **Interpolation and naming:** `interpolate`, `defaultedArguments`, `isICU` and `derivePlaceholderNames`.
- **Legacy keys:** `createLegacyKeys` and its converters.
- **Snapshots:** `buildSnapshot`, `parseSnapshot` and `SnapshotError`.
- **Server messages:** `resolveServerMessages`, `templateMarkers` and `fillTemplate`.

The DOM walkers (`tokenizeElement`, `encodeRichText`) and everything that sends a request are on the main entry only.
