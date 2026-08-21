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
