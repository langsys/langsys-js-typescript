# Writing from the SDK

Whether a session registers what it misses is the server's decision, made for each session from the API key, the address the request comes from and any write grant. **That concept belongs to the entry skill:** `langsys` covers `write_enabled`, the key types, the `ip_write` allow-list, write grants and what to check when nothing registers. Read it first, in projects-and-keys.md in the installed `langsys` skill, or at [https://docs.langsys.dev/skill/langsys/projects-and-keys.md](https://docs.langsys.dev/skill/langsys/projects-and-keys.md). This file is how the TypeScript core exposes the decision and acts on it.

## Reading the decision

```ts
import { autoDiscovery, writeEnabled } from 'langsys-js-typescript';

writeEnabled.get();    // undefined until the server answers, then true or false
autoDiscovery.get();   // whether the key may report pages for discovery
```

The server answers `write_enabled` when `init()` authorizes, and again with every catalog it serves. `writeEnabled` follows each answer without a re-init. The SDK never decides from the key's type and never caches the decision.

`undefined` means the server hasn't answered yet, not "no". Misses found in that window are held, not dropped, and settle when the answer arrives. `writeEnabled` is only ever set in a browser. On a server it stays `undefined` for the life of the process, so never branch on it there.

When a `write` or `ip_write` key's session comes back read-only, the SDK logs **one** warning saying so, outside debug too. A `read` key stays silent, because for it read-only is the configured outcome. If you see that warning, the key isn't the problem: work through the entry skill's checks.

What the signal tells you when phrases aren't appearing:

- **It stays `undefined` in a browser:** `init()` hasn't been called, or hasn't finished.
- **It's `false` and `init()` resolved `status: false`:** authorization was refused, or the core has no credentials. Fix that first ([init-config.md](./init-config.md)).
- **It's `false` and `init()` succeeded:** the server made the session read-only. The entry skill says why that happens.
- **It's `true` and nothing registers:** not a capability problem. Check the primitive and the content ([primitives.md](./primitives.md), [invariants.md](./invariants.md)) and `data-ls-resolved` (below).
- **On a server:** nothing in the browser decides it ([server-rendering.md](./server-rendering.md)).

## Write grants

An app behind a login makes its signed-in users' sessions write-enabled with a **write grant**, a short-lived token your backend mints. The SDK sends it as `X-Write-Grant`.

```ts
import { LangsysApp, setWriteGrant } from 'langsys-js-typescript';

await LangsysApp.init({
    projectid, key, UserLocaleStore,
    writeGrant: () => session.langsysGrant ?? null,   // called before each request, never cached
});

await setWriteGrant(() => fetchGrant());              // replace it later; the session re-authorizes
```

- **Pass a function, not a string.** It's called before each request, so the token is always fresh. Grants expire within minutes, so a bare string works for a quick start and then stops.
- **Return `null` until there is one,** and configure the provider at `init()` even though the token only exists after login. With no provider configured, a read-only answer means no grant can ever arrive, so the session stops holding its misses for one.
- **While a grant is configured, `ssrTokenStrategy` acts as `'client'`.** A grant decides per user, and a server process renders for many.

## Read-only sessions report where content is

A session that can't write still tells Langsys **where** its untranslated content is, never what it says. When `t()` or a content block misses, the SDK reports the page's URL and nothing else, and Langsys records it. It waits a random 5 to 30 seconds and reports at most once per URL per browser session.

- **Only where the key's policy allows it.** The policy arrives as `autoDiscovery`.
- **Tracking parameters are stripped first** (`utm_*`, `gclid`, `fbclid` and the like).
- **Some URLs are never reported:** one carrying a credential-shaped parameter (`token`, `password`, `session`, `email` and the like).
- **No double path:** a session that can write registers and never reports. Nothing is reported from a server render.

A report isn't a registration. Content registers only from a session that can write. For a public site, which ships an `ip_write` key, that means one of three things:
- a browser at an address on the key's allow-list, such as your own machine, a staging server or a crawl you run;
- a server rendering from an allow-listed address under `ssrTokenStrategy: 'server'` ([server-rendering.md](./server-rendering.md));
- a signed-in user's session holding a write grant.

Visitors' read-only sessions never fill the catalog, so to register what a public site shows, browse or crawl it from an allow-listed address.

## Route changes: `notifyNavigation()`

**After a client-side route change, call `notifyNavigation()`.** Content that stays mounted across routes, such as a header or a layout, is otherwise looked up only for the first URL, so its misses are never recorded for the pages the visitor moves to. The call publishes a fresh `t` through `tSignal`, records later misses at the new URL, and has attached `Translate` and `Phrase` instances look up again. It sends nothing itself. A binding wires it to its router.

## Settings that narrow both

- **`data-ls-resolved`** on an element or an ancestor: nothing inside registers or is reported, because a server already rendered it from the catalog ([primitives.md](./primitives.md)).
- **The project's base-locale-only setting:** the SDK registers and reports only on pages shown in the base locale, so a page served already translated never files its translation as source. The server sends the setting with its answer; nothing is configured in the SDK, and a registration it stops resolves `base-locale-gate`.

## What a registration result says

`registerContentBlock` and a request scope's `close()` resolve a `RegistrationResult`, and never throw:

| Result | Meaning |
|---|---|
| `{ status: true }` | The server stored it |
| `skipped`, `not-configured` | No credentials ([init-config.md](./init-config.md)) |
| `skipped`, `not-write-enabled` | The session can't write. In a browser, the page's URL is reported instead |
| `skipped`, `catalog-unavailable` | The catalog fetch failed, so an unknown block can't be told from a registered one |
| `skipped`, `base-locale-gate` | The project registers only at its base locale |
| `skipped`, `deferred` | Found inside a request scope, which sends it at `close()` |
| `skipped`, `client-strategy` | `ssrTokenStrategy` (or a write grant) leaves collection to the client |
| `refused` | The server answered with a failure; `errors` says why |
| `failed` | The request didn't complete |
