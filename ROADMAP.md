# Roadmap / known gaps

Running list of deferred work and design decisions for `langsys-js-typescript`,
so the context isn't lost between sessions.

## BACKLOG: converge `TRANSLATABLE_ATTRIBUTES` on PHP's 27 (adopt the missing 12)

**Decided 2026-08-21 (Darryl):** the JS and PHP translatable-attribute lists
converge on PHP's 27. JS adopts the 12 it is missing. **Not started** — blocked
on one migration decision, below.

### What the gap is

`src/content-block.ts:48-64` defines 15 translatable attributes.
`langsys-php`'s `HtmlParser::DEFAULT_TRANSLATABLE_ATTRIBUTES` defines **27**.
Because `generateCustomId` hashes `JSON.stringify([category, tokens])`, an
attribute one implementation harvests and the other doesn't produces a
different token list and therefore a **different `custom_id` for the same
markup**.

The symptom is silent catalog fragmentation: the block registers twice,
translators see duplicates, half the app resolves and half falls back to base
language, and nothing errors. It surfaces weeks later as "some pages aren't
translated". This is not hypothetical for this codebase —
`generateLegacyCustomId` exists precisely because an id-generation change
orphaned catalogs once already.

Today, any element carrying one of the twelve tokenizes differently in JS than
in PHP. That divergence is live, not prospective.

### The omission was deliberate, and the reason it no longer holds

`src/content-block.ts:39-47` documents the current 15 as a considered choice,
not an oversight:

> Framework-convention attributes (Bootstrap `data-bs-*`, Rails
> `data-confirm`, and similar) are deliberately NOT mirrored: they're written
> by server-rendered templates, and **a JS app renders those strings through
> its own components instead.**

That rationale was sound for a client-only JS family, and it is exactly what
`langsys-js-server` invalidates. A JS package that renders HTML server-side is
the case the comment excludes. So converging on 27 is not overriding a
considered decision carelessly — it is a decision whose premise expired.

**When the twelve land, that comment must be rewritten, not extended.** Left
as-is it will read as documenting a deliberate omission that no longer exists,
which is worse than no comment: the next maintainer would take it as a reason
not to touch the list.

The same paragraph's argument for the *shared* 15 is unaffected and should
survive the rewrite — an attribute only one side harvests is a coverage hole,
not a conflict.

### The twelve, in canonical order

They append to the existing 15 — **this order is load-bearing**, see below.

```
data-confirm            // Confirmation dialogs (Rails, etc.)
data-tooltip            // Tooltip text
data-title              // Alternative title attribute
data-content            // Popover/modal content
data-original-title     // Bootstrap 3/4 tooltips
data-bs-title           // Bootstrap 5 tooltips
data-bs-content         // Bootstrap 5 popovers
data-loading-text       // Loading button states
data-success-message    // Success notifications
data-warning-message    // Warning notifications
data-empty-message      // Empty state messages
data-placeholder        // Custom placeholder attributes
```

### What makes this mechanically cheap — verified, not assumed

Checked against **`langsys-php` at tag `v1.3.1`**, not the local working tree,
which was `v1.3.1-9-g87373f2` — nine commits ahead — at the time of writing.
`git show v1.3.1:src/Html/HtmlParser.php` diffed clean against the working tree
for that constant, so the lead didn't affect it. Reading the working tree
directly would have been the exact trap this project keeps rediscovering.

- **Our 15 and PHP's first 15 are identical, in identical order.**
- **PHP's extra 12 are one contiguous block appended after them**
  ("Common framework patterns").

So this is an **append**. Nothing already in the list changes position. That
matters more than it looks: token emission order *is* `custom_id` identity, so
had PHP interleaved its extras, every block carrying *any* translatable
attribute would have re-keyed. As it stands, only blocks carrying one of the
twelve are affected.

Also already aligned and unaffected by a longer list: `value` is emitted after
the whole constant loop, then `<button>`, then `<input type="submit|button">`
(`src/content-block.ts:349-392`) — matching PHP.

### BLOCKING QUESTION: how existing blocks migrate

Every JS-registered content block whose subtree carries one of the twelve with
a non-empty value changes `custom_id` and **orphans its translations**. Every
other block is byte-identical and unaffected.

Two options:

1. **Second fallback.** `Translate` tries the 27-attribute id, falls back to
   the 15-attribute id. Cheap now, permanent later.
2. **Rebase catalogs once.** Recompute ids server-side for affected blocks.
   Backend work, retires the debt.

**This is a lookup, not a judgement call.** The blast radius is queryable:
content blocks whose stored `content` HTML contains any of the twelve
attribute names. At a handful of blocks, rebasing is obviously right; at
thousands, obviously not. **Get the count from the Translation Manager before
choosing** — nobody involved in the design discussion had it.

**A distinction worth preserving if option 1 wins.** A second fallback here is
*not* another `generateLegacyCustomId`. That one exists because the **hash
input encoding** changed (`tokens.join('-')` → `JSON.stringify`), which is why
its doc comment warns to reason about the final hashed string rather than the
phrase. This would be the **same** `generateCustomId` over a **shorter
attribute list** — a second token derivation, not a second hash. Both are
links in a chain and a chain of two is harder to retire than either link, but
describing them as the same kind of debt will make the eventual cleanup harder
to reason about. `generateLegacyCustomId` is already marked
`@deprecated — will be removed once catalogs have been rebased`.

### Sequencing — this repo is the head of the chain

The bindings (`-react`, `-vue`, `-svelte`) inherit the list from here, and the
planned `langsys-js-server` package depends on it too.

**`langsys-js-server` must not ship 27 before the client family has them.** If
it does, it disagrees with its own hydration hand-off partner on every request
— the same fragmentation, pointed the other way. Either the client SDKs ship
the twelve first, or the new package pins a base-SDK floor that guarantees
them. This constraint is recorded in that package's `SPEC.md` §9.

### Constraint for the conformance suite

PHP's list is **runtime-mutable** via `HtmlParser::setTranslatableAttributes()`
(`src/Html/HtmlParser.php:96`). That makes `custom_id` a function of
*configuration* rather than of content.

Any cross-SDK conformance fixture set **must pin the attribute list
explicitly**. A suite that doesn't certifies whatever the runner happened to be
configured with and reports it as parity — a green check with no signal behind
it, which is this project's recurring failure class wearing a passing test.

`langsys-js-server` deliberately exposes no equivalent setter for this reason.

### Provenance

Raised by the `langsys-skill` agent during the `langsys-js-server` spec review
(2026-08-21) after the `langsys-php` agent executed both tokenizers and found
the lists differed. Decided by Darryl the same day. Mechanical claims
re-verified here against the tagged PHP release; the migration question was
deliberately left open rather than answered by whoever noticed it.

## BACKLOG: skip `<script>` / `<style>` content when tokenizing

**Not started.** Raised 2026-08-21 by the `langsys-js-server` agent, originally
measured by the `langsys-php` owner on their side. Reproduced here against the
published `0.6.5` dist:

```
<p>Keep</p><script>window.dataLayer.push({event:"view",sku:"ABC-123"})</script>
   -> ["Keep", "window.dataLayer.push({event:\"view\",sku:\"ABC-123\"})"]

<p>Keep</p><style>.plan{color:#fff}</style>
   -> ["Keep", ".plan{color:#fff}"]
```

`_walkForTokens` has no element skip list. A `<script>` is not excluded, is not
phrase-marked, and has a text-node child — so its child becomes a token like
any other. With a write key that content is **registered permanently into the
shared catalog**: translators are shown executable JS and CSS, and registered
phrases cannot be withdrawn.

This is a product harm on top of an id problem, which is what distinguishes it
from the attribute convergence — that one fragments catalogs, this one puts
garbage in them irreversibly.

### Scope: `script` and `style`. NOT `noscript`.

`<noscript>` content **is** user-visible — it renders whenever scripting is
off, and "Enable JavaScript to continue" is exactly the kind of string that
should be translated. It currently tokenizes (`["Keep","Enable JS"]`,
measured) and should keep doing so. A skip list that sweeps it in because it
looks technical would be a regression disguised as a fix.

### `<template>` is a parser accident, not a skip

Measured: `<template><b>Hidden</b></template>` yields **no** tokens — but not
because anything skips it. `HTMLTemplateElement.content` lives in a separate
`DocumentFragment`, so `childNodes` is empty and the walk finds nothing.

**A server-side implementation parsing an HTML string may not reproduce that**,
and would harvest template contents that the DOM path silently ignores. So
`template` belongs in an explicit skip list precisely *because* the current
behaviour is accidental — that makes it intentional and portable rather than
dependent on a DOM quirk no fixture would think to pin.

### Blocked on the same question as the attribute convergence

Skipping changes `tokens[]`, therefore `custom_id`, for every existing block
containing a `<script>` or `<style>`. Same migration decision: second
derivation vs. one-time rebase, priced by a count that is queryable from the
Translation Manager. See the attribute entry above — the two changes should
almost certainly migrate **together**, as one re-key rather than two.

`langsys-php`'s `tokenizer-reference.json` case [12] currently pins the
un-skipped output (`["Keep","var a=1;",".a{}"]`) as the contract, so the shared
fixture has to change in step. That makes this a cross-SDK coordination, not a
local fix.

### Meanwhile, `langsys-js-server` diverges deliberately

That package skips `script`/`style`/`noscript`/`template` and does **not**
implement bug-compatibility, at the PHP owner's request. It mitigates the
fragmentation rather than accepting it: its primary id uses the skip list, and
on a catalog miss it re-derives under the un-skipped rules before treating a
block as new, so blocks registered by this SDK still resolve there.
Registration always uses the corrected derivation. It asserts the divergence as
a test that fails when we converge, rather than skipping the case.

## DEFECT (partly fixed on `feature/838_write_key_gating_reland`): the single-token fast path destroys the subtree

**Status, 2026-08-21.** Manifestation 2 is FIXED on that branch; manifestation 1
is NOT, and remains live. `renderSingleToken` now writes into the element's
single non-whitespace text node instead of assigning `innerText`, so framework
anchor comments and wrapper markup survive. Where there is NO text node — which
is exactly the attribute-only case in manifestation 1 — it still falls back to
`innerText` and still destroys the element.

Measured against the branch rather than reasoned about:

```
<div><img alt="Alt text"></div>          -> innerHTML "Texto alt"   STILL BROKEN
<div><input placeholder="Your name"></div> -> innerHTML "Tu nombre"   STILL BROKEN
<div><!--[-->loading<!--]--></div>       -> both anchors survive     FIXED
```

The remaining fix is not the same shape as the one applied: an attribute-sourced
token has no text node to write into, so the single-token fast path should not
claim it at all — it belongs on the node-walking path that already handles
attributes. That is a behaviour change to which branch runs, and is left for its
own change rather than folded in here.

**Originally raised as: Not started.** Raised 2026-08-21 by `langsys-skill`, from a SvelteKit
reference deployment. Verified here against `src/translate.ts` and reproduced
against the published `0.6.5` dist. **This is a live defect in client-only
apps — no SSR involved.**

`src/translate.ts:109-110` and `:137-138`, both sites identical:

```ts
if (this.tokens.length === 1) {
    this.element.innerText = this.applyParams(LangsysApp.Translations.t(this.tokens[0], category));
}
```

Assigning `innerText` **replaces every child of the host element.** The fast
path assumes "one token" means "one text node". It does not.

### Manifestation 1 — attribute-only tokens lose their element entirely

Framework-independent; reproduces in vanilla DOM. Measured:

```
<Translate><img alt="Alt text"></Translate>
   tokens = ["Alt text"]  -> fast path -> innerHTML becomes "TRANSLATED"

<Translate><input placeholder="Your name"></Translate>
   tokens = ["Your name"] -> fast path -> innerHTML becomes "TRANSLATED"
```

**The `<img>` / `<input>` is gone**, replaced by the translated string as
text. A single token can come from a translatable attribute (§
`TRANSLATABLE_ATTRIBUTES`) with no text node anywhere in the subtree.

### Manifestation 2 — framework anchor nodes are destroyed

Svelte 5 marks blocks with `<!--[-->` / `<!--]-->`. Measured:

```
before: childNodes=3 anchors=2 html="<!--[-->loading<!--]-->"
after : childNodes=1 anchors=0 html="cargando"
```

Subsequent framework updates then target nodes no longer in the document. The
reference deployment measured an `{#await}` block frozen on its pending branch
permanently — `textContent "loading"` at 50 ms with both promises resolved —
and the identical run without the write-back reaching resolved content, so the
write is the cause, not hydration.

`{#await}` guarantees the two preconditions at mount (single-token subtree,
framework updates it afterwards) because `render()` is synchronous and a
promise settles no earlier than a microtask. **`{#if}`, `{#each}` and any
reactive single-token content are the same shape but are NOT measured** —
flagged rather than claimed.

### Two things that compound it

- **Tokenization happens once, in the constructor.** The only re-entry is
  `currentlyLoadedLocale.subscribe(...)` → `translateUpdate()`, which does not
  re-tokenize, and there is no MutationObserver. So `this.tokens` is
  permanently whatever the first render produced — for `{#await}`, always the
  pending placeholder. The real content is never registered at all, and every
  `{#await}` sharing a pending string collapses onto one id.
- **The write repeats on every locale change.** `translateUpdate` sets
  `this.lastTranslatedLocale = currentLocale` **only in the `else` branch**
  (`:113`). The single-token branch never sets it, so the guard at `:105` never
  short-circuits and the destructive write re-runs on every emission.

### Direction for a fix

Write text without replacing children: locate the single text node the token
came from and set its `nodeValue`, leaving siblings — including comments the
framework owns — untouched. **The attribute case must not write text at all**;
it should update the attribute, which is what the multi-token path already
does via `translate()`.

The requirement to hold regardless of mechanism: **whatever replaces this must
be safe to call on a subtree a framework owns**, because the SDK cannot know
whether it does.

Fixing it does **not** change `custom_id` or the catalog — tokens are computed
before the branch, and the branch only decides the DOM write and
phrase-vs-content-block registration. So unlike the other two entries in this
file, this one carries no migration.

### Not verified

Nobody has run this end-to-end against a live project with a write key — that
would POST content blocks to a real catalog. The DOM consequence is
string-independent, which is what makes the isolated reproduction sound, but
the catalog behaviour under a real write key is inferred, not measured.
Harness: `~/DATA/IDE/EWS/affsite-platform/…/scratchpad/svelte-tok/`, with a
`writeBack` prop toggling the write; they have offered to re-run variants.

### Constraints on the fix, measured by the Svelte binding

Three properties measured against published `0.6.5` in jsdom, verified here
against `src/translate.ts`. They shape the fix rather than the diagnosis.

**a. The single-token branch is decided once and cannot be re-crossed.**
`this.tokens` is assigned only at `:132`, inside `tokenizeContent()`, which is
called only at `:74`. No MutationObserver, no re-tokenize path. So a block that
starts multi-token and later collapses to one phrase keeps taking the
multi-token path — `translateUpdate` re-reads `this.tokens.length`, but that
array is the one captured at construction.

This is a **property to preserve or change deliberately, not incidentally.** If
a fix introduces re-tokenization, a block that collapses to a single token
becomes newly eligible for whatever the single-token path does — a behaviour
change even once the destructive write is gone.

**b. `parseComplete` means two different things, and one of them is
unrecoverable.** `tokenizeContent()` early-returns when
`element.childNodes.length` is 0 and sets `parseComplete = true` **without
tokenizing** (`:119-122`). Nothing re-enters, so that block never registers
anything. Measured:

```
client-only mount, {#await} inside <Translate>   phrases looked up: []
same component, hydrated over SSR html           phrases looked up: ["loading"]
```

Zero lookups client-only — not the placeholder, not the real content. The
framework populates the host a tick after the effect runs, and by then the
block is marked parsed. Worth separating *tokenized* from *gave up before
tokenizing* independently of the write, because the second state produces no
symptom at all.

Note the downstream shape: `:78` gates on `parseComplete`, so a gave-up block
still enters `translateUpdate` on a locale change, with `tokens === []` — which
takes the `else` branch and calls `translate()` on a subtree that was never
tokenized or registered.

**c. Scope for the regression test.** Single-token blocks freeze on any
subsequent framework update; the update mechanism is irrelevant (runes and
store subscriptions behave identically, client-only and hydrated). Multi-token
subtrees are unaffected. **`{#await}` reproduces only under hydration**, for
the reason in (b) — so a client-only-only test would show it passing. Any
regression test must cover the hydrated path or it certifies nothing.

The Svelte binding has offered to re-run all of these against a release
candidate before publish; their harness is already set up.

### The third state, traced — no line sets `parseComplete` false

The Svelte binding measured a live instance resting at
`parseComplete=false tokens=[] element.childNodes=6` and correctly declined to
guess the line. There isn't one. **`tokenizeContent()` never reaches its
assignment**, because it is suspended at an `await`.

Path for a non-empty host that tokenizes to nothing (Svelte anchor comments
are `childNodes`, so the `:119` empty guard does not fire):

```
:131  tokenizeElement()            -> tokens = []   (comments only)
:137  this.tokens.length === 1     -> false
:145  await this.handleContentBlock(contentBlock)
        -> handleContentBlock: await LangsysApp.Translations.ready()
:150  this.parseComplete = true    <- NEVER REACHED while ready() is pending
```

`ready()` resolves in exactly four places (`translations.ts:270`, `:288`,
`:399`, `:422`), all inside catalog-load paths. `Translations`' constructor
only calls `setup()` when `config.key && config.projectid`, so with no
completed `init()` there is no fetch and nothing ever resolves it. Measured:

```
ready() without init():  STILL PENDING after 300ms
```

Two consequences:

- **This is not specific to zero tokens.** *Any* multi-token block is suspended
  at that same `await` between mount and the first catalog fetch settling. In a
  healthy app that window is short; if `ready()` never resolves it is
  permanent.
- **While suspended, the block is deaf** — but only while suspended. The
  constructor's locale subscriber is gated `if (locale && this.parseComplete)`
  (`:78`), so a suspended instance does not re-enter. **CORRECTED
  2026-08-21:** an earlier version of this entry said "inert for the lifetime
  of the page." That was wrong, and wrong in the direction that makes the bug
  sound worse than it is. Resolving `ready()` unsticks it. Measured here:

  ```
  no init():          parseComplete=false  tokens=[]
  after markLoaded(): parseComplete=true   tokens=[]
  ```

  Permanent deafness needs `ready()` to never settle, which is not the normal
  case. In a healthy app the suspension is transient and the block is
  reachable afterwards.

So the boolean has **three** states, and the third arrives from a direction the
first two don't suggest: *tokenized*, *gave up on an empty host* (`:120`), and
*suspended mid-tokenize and never resumed*. A fix that only separates the first
two leaves this one inert.

**What the replacement needs to distinguish** — the Svelte binding's framing,
which is the right one: *nothing to tokenize yet* (recoverable, retry) from
*tokenized and found nothing* (a real answer, don't retry). Neither is the same
as *still waiting on the catalog*.

**Regression test — the first version of this was wrong.** An earlier entry
required "assert the block is reachable after a client-only `{#await}`."
**Reachability passes today** (see the correction above), so that assertion
certifies nothing. The one that actually fails is on **registration**: after a
client-only `{#await}` settles, the block's `tokens` should be non-empty and
its content should be in the catalog. Assert that, plus the hydrated
`{#await}` case.

**The durable defect, true in both modes and surviving every correction in
this thread: `tokens=[]`.** The block never registers anything, in healthy apps
too. Everything about deafness and re-entry was contested and half-retracted;
this was not.
