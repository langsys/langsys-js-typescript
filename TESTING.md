# Testing this branch locally

How to try the core by hand before a release: build it, link it into a binding or a plain page,
run it against the contract double, and see each feature of this branch work. Where another
document already covers a step, this page points to it.

## 1. Build and run the checks

```sh
npm install
npm run build              # dist/: the package build and the browser build
npm test                   # the whole suite; it builds first
npm run typecheck
npm run tally:conformance  # CONFORMANCE.md against the spec; prints "verdict: GREEN"
npm run verify:spec        # needs the sibling ../langsys2 checkout
```

`npm test -- tests/<name>.test.ts` runs one file. The suites named below are the automated proof
of each feature; this page adds what you can see yourself.

## 2. Use this checkout from a binding or a page

**A binding** (`langsys-js-svelte`, `-react`, `-vue`, …) uses this checkout when its
`node_modules/langsys-js-typescript` points at it:

```sh
cd ../langsys-js-react
npm link ../langsys-js-typescript     # or: ln -sfn "$PWD/../langsys-js-typescript" node_modules/langsys-js-typescript
ls -l node_modules/langsys-js-typescript   # confirm where it points
```

Run `npm run build` here after every change: a binding loads `dist/`, not `src/`. Other agents'
lanes may point their bindings at their own copies of the core, so check the link before you
trust what a binding shows.

**A plain page:** `example/index.html` loads the browser build (`dist/langsys.browser.mjs`). Serve
the repository root (`npx serve .` or any static server) and open `/example/`. Set `projectid`
and `key`, and point it at an API with `apiUrl` (see the README, "Pointing at a different API
host"). A browser cannot call the contract double, which sends no CORS headers, so a page runs
against a real API: your local backend (for example `http://langsys2.test/api`) or the live one.

## 3. The contract double

`contract-fixture/README.md` is its manual: the routes, what it enforces and in which order, the
seed document, the error codes, and what it does not model. In short:

```sh
node contract-fixture/server.mjs     # prints {"ready":true,"base_url":"http://127.0.0.1:PORT/api",...}
```

Start it **without** `--port`, and take the URL from the line it prints. Other lanes run their
own doubles on fixed ports, and a seed you send to one of theirs replaces its whole state.

Seed it with a document matching `contract-fixture/seed.schema.json`:

```sh
FX=http://127.0.0.1:PORT/__fixture
curl -s -X POST $FX/seed -H 'content-type: application/json' -d '{
  "projects": [{ "id": "p1", "base_locale": "en", "target_locales": ["es-es", "de-de"],
                 "website_url": "https://site.local",
                 "phrases": [{ "category": "UI", "phrase": "Hello",
                               "translations": { "es-es": "Hola", "de-de": "Hallo" } }] }],
  "keys": [{ "key": "k-write", "project": "p1", "type": "write" },
           { "key": "k-read",  "project": "p1", "type": "read" }]
}'
curl -s $FX/state     # what the double accepted: phrases, blocks, hints
```

Point the SDK at the double with `apiUrl: 'http://127.0.0.1:PORT/api'` in `LangsysApp.init`.
From Node that works directly; a quick session:

```js
// node --input-type=module, from this repository's root
import { LangsysApp, createSignal, createRequestScope, t, tokenizeTree, localeHeaders } from './dist/index.mjs';

const locale = createSignal('es-es');
await LangsysApp.init({ projectid: 'p1', key: 'k-read', UserLocaleStore: locale, baseLocale: 'en',
                        apiUrl: 'http://127.0.0.1:PORT/api' });
await LangsysApp.Translations.ready();
console.log(t('Hello', 'UI'));                                   // Hola
```

## 4. One check per feature

Each check says what you should see, and which suite proves it.

**Write-key gating.** Whether a session may register is the server's `write_enabled`, never the
key's type. In a browser with a write key, new text on the page appears in `GET $FX/state`, or in
the Translation Manager on a real backend, a moment after it renders. With a read key, the page
renders the same translations and nothing new is registered. With `debug: true` the console says
why ("Skipping content block save (session is not write-enabled)"). README: "API key
permissions". Suites: `contract-write-lane`, `write-lane`, `never-attempt`.

**Block ids and the shared vectors.** A `<Translate>` host is stamped with its id,
`data-ls-contentblock="<32 hex>"`. The same content gets the same id in every SDK. The vectors are
`tests/fixtures/canonicalization-reference.json` (this repo authors it, and PHP measures every
row) and the vendored `custom-id-reference.json` and `tokenizer-reference.json`. To see it, inspect
the stamp on the example page's `#article`. Suites: `canonicalization-agreement`,
`content-block-identity`, `custom-id-cross-impl`, `tokenizer-cross-impl`.

**Value markers.** A printed value marked `<!--ls:name-->Ana<!--/ls-->` (or
`<span data-ls-param="name">Ana</span>`) registers as one phrase, `Hello {name}`, for every user:

```js
tokenizeTree([{ tag: 'p', children: [{ text: 'Hello ' }, { comment: 'ls:name' }, { text: 'Ana' },
                                      { comment: '/ls' }, { text: '!' }] }]);
// { tokens: ['Hello {name}!'], shape: 'phrase' }
```

On a page, two hosts saying `Hello <!--ls:name-->Ana<!--/ls-->` and `…Luis…` register one phrase.
README: "Variables in registered text". Suites: `var-markers`, `var-naming`.

**The request scope on a server render.** Each request renders in its own locale and catalog,
and the page's state is untouched:

```js
const de = await createRequestScope({ locale: 'de-de' });
console.log(de.run(() => t('Hello', 'UI')), t('Hello', 'UI'));   // Hallo Hola
```

`de.seed()` is what the page hands the browser. README: "Rendering on a server: request scopes".
Suites: `request-scope`, `scope-from-seed`, `contract-served-block`.

**The settle observer.** A block that mounts showing a placeholder registers the content it
settles on. On a page with a write key (in the example page, inside its module script, where
`Translate` is imported), mount `new Translate(el, { category: 'UI' })` on
`<div><p>Intro</p><p>Loading…</p></div>`, then replace the second `<p>` within 500ms
(`setTimeout(() => el.lastElementChild.replaceWith(Object.assign(document.createElement('p'), { textContent: 'Real content' })), 100)`):
only the block with the real content is registered. Replace it
after a second instead, with `debug: true`, and the console names both ids: the one first
registered and the one the block re-keyed to. README: "The `Translate` class". Suites:
`settle-window`, `contract-served-block`.

**Hints.** A read-only session that misses text reports the page's URL so the renderer can visit
it. That needs a key allowed to report (`report_discovered_content`), a page on the project's
`website_url`, and the other acceptance rules listed in `contract-fixture/README.md`, "What it
enforces". On a real backend the hint shows up as a visit from the renderer. In the double,
accepted hints are in `GET $FX/state`, under `hints`. Suites: `contract-hint-lane`, `discovery`,
`navigation`.

**The locale header helper.** `localeHeaders()` names the user's current locale:

```js
locale.set('de-de');
console.log(localeHeaders());    // { 'Accept-Language': 'de-de' }
```

README: "Asking your own API for the user's language". Suite: `locale-headers`.

## 5. Where conformance stands

`CONFORMANCE.md` lists every spec rule, its status, and the test that proves it; the header names
the spec revision it was checked against.
