# Choosing the primitive

Read this before marking any content. Picking the wrong primitive is the most common integration error, and it doesn't show in the base language.

| Content | Primitive | What registers |
|---|---|---|
| Plain text, no markup | `t()` | One phrase |
| One sentence that contains inline markup | `Phrase` | One phrase, with the markup as `{m0o}`…`{m0c}` tokens |
| A block of markup with several units: an article, a form, a nav | `Translate` | One content block: each text node and translatable attribute is a token, under an id derived from the category and the tokens |

The question is **not** how big the content is. It's this:

> **Does this tag boundary belong to the language, or to the layout?**

A `<strong>` inside a sentence belongs to the language: the sentence is one unit and is translated as one. A `<p>` between two paragraphs belongs to the layout: they are separate units.

`Phrase` and `Translate` are two pipelines, not two settings of one. `Translate` registers a **content block** with a computed id. `Phrase` registers a **phrase string** and looks it up like any `t()` phrase, with no block and no id. They put different things in the catalog, and choosing wrong is invisible in the base language.

A binding's components wrap these classes, and its own skill covers them. Content to keep verbatim carries `translate="no"` (below).

## `t()`

```ts
import { t } from 'langsys-js-typescript';

t('Save');                                   // no category, no params
t('Save', 'UI');                             // categorized
t('Hello, {name}!', { name: 'Ana' });        // params, no category
t('Hello, {name}!', 'Greetings', { name });  // category and params
```

`t()` returns a string and is not reactive by itself: it reads the current catalog each time it's called. To re-render on a locale or catalog change, subscribe to `tSignal` ([init-config.md](./init-config.md)). HTML inside a `t()` string is never rendered as markup. A sentence with markup is a `Phrase`.

`t` is also a template tag, `` t`Hello ${{ name }}` ``, which has rules of its own ([interpolation.md](./interpolation.md)).

## `Phrase`: one sentence with inline markup

```ts
import { Phrase } from 'langsys-js-typescript';

const handle = new Phrase(document.querySelector<HTMLElement>('#reviews')!, {
    category: 'ProductCard',
    params: { n: reviewCount },
});

handle.setParams({ n: 6 });   // re-renders
handle.destroy();             // stops listening
```

```html
<span id="reviews">Based on {n} <strong>reviews</strong></span>
```

That registers one phrase, `Based on {n} {m0o}reviews{m0c}`, not `Based on {n}` and `reviews`. Three things depend on it:

1. **Grammatical agreement.** A count and the noun it inflects must be in one phrase, or no plural rule can choose the noun's form. Russian has four plural categories and Arabic six. Split them and the translation is wrong, not merely awkward.
2. **Word order.** The markup tokens are ordinary ICU placeholders, so a translator places them around the translated word: `{m0o}White{m0c} House` → `Casa {m0o}Blanca{m0c}`.
3. **Key stability.** The real elements never reach the key; they are rebuilt around the translated text at render. Build-generated class names would otherwise change the key on every build.

An element excluded inside a phrase (`translate="no"`, `data-notrans`, or code such as `<script>`) is one empty pair in the key, whatever it holds. So `Signed in as <span translate="no">a@b.c</span> today` is `Signed in as {m0o}{m0c} today` for every user. The excluded element renders as the page has it, and a `{key}` or `%key%` inside it is filled from the params. A phrase made only of excluded content registers nothing. If a translation drops or unbalances a markup token, the phrase renders as plain text with the markers stripped.

## `Translate`: a block of markup

```ts
import { Translate } from 'langsys-js-typescript';

const handle = new Translate(document.querySelector<HTMLElement>('#article')!, {
    category: 'Blog',
    label: 'Welcome post',       // what translators see the block called
    params: { name: 'Ana' },
});

handle.setParams({ name: 'Luis' });
handle.destroy();
```

It tokenizes each text node and translatable attribute, registers the block, re-translates on locale change, and stamps the block's id on the element as `data-ls-contentblock`. `custom_id` registers the block under an id of your own instead of the derived one.

**It splits at every tag.** `<p>My content <strong>is the best</strong> when internationalized.</p>` registers three phrases. That's right for a block of independent runs and wrong for a sentence: put that sentence in a `Phrase`.

- **What a block shows at mount is provisional.** It renders at once, but registers only once the element's structure has been quiet for 500 ms, so a loading placeholder swapped out quickly never registers. A later structural change, such as a list growing, re-reads the block under the id its new content derives.
- **Structure is kept.** A single-run block writes into its one text node, and every other shape is translated node by node in place, so ids, refs and test attributes on children survive.
- **Translatable attributes:** `placeholder`, `alt`, `title`, `label`; `aria-label`, `aria-placeholder`, `aria-description`, `aria-valuetext`, `aria-roledescription`; and the message and widget `data-*` names in `TRANSLATABLE_ATTRIBUTES` (exported from `/pure`: `data-error`, `data-tooltip`, `data-confirm`, `data-bs-title` and the rest). `value` is translated only on `<button>`, `<input type="submit">` and `<input type="button">`, where it is a label. `<option>` text inside `<select>` is translated too.
- **Opting out:** `translate="no"` or `data-notrans` skips the element and everything in it, and nothing inside can opt back in. `data-notrans="false"` or `="0"` leaves the attribute without effect, and any other `translate` value means nothing. `<script>`, `<style>`, `<template>`, `<noscript>`, `<plaintext>` and `<math>` are always skipped (`NON_TRANSLATABLE_ELEMENTS`, from `/pure`). Text inside `<svg>` is translated.

### Units inside a block

The tokenizer leaves out any subtree that carries a marker, and that subtree is a unit of its own:

- **`data-ls-phrase`** makes the element one phrase, registered whole. **Write it in the HTML.** The `Phrase` class does not set it on its host, so a `Phrase` inside a `Translate` without the attribute gets tokenized straight through. Construct a `Phrase` on the marked element when you need `setParams()`; it takes over from the block.

  ```html
  <div id="article">
    <p>Some prose the block tokenizes normally.</p>
    <p data-ls-phrase>Based on {n} <strong>reviews</strong></p>
  </div>
  ```

- **`data-ls-contentblock`** makes the element a block of its own, under its own `data-ls-category` when it names one. A bare, `true`, `1` or `yes` value declares a block; `false` or `0` opts out; any other value is the block's id. `Translate` adds this marker when it is constructed on an element. So when the markup doesn't already carry it, construct the inner `Translate` before the enclosing one: the enclosing block reads its words when it is constructed.

**`data-ls-resolved`** isn't a unit marker. On a block's or a phrase's host, or on an ancestor of it, it marks text a server already rendered from the catalog: nothing in that host registers and no miss is recorded, because that text is a translation, not source. The nearest marked ancestor decides, so `="false"` or `="0"` on a subtree opts it back out. On an element inside a block it has no effect, and the block tokenizes that element with the rest.

`langsys-php`'s `data-langsys-*` spellings of these markers are read the same way.

### Rendering without registering

`register: false`, on `Translate` or `Phrase` (and on `registerBlock`), renders from the catalog and registers nothing. One debug notice says so. Use it for content that can't be named, never as a stand-in for a read-only key.

### Registering a block from your own DOM

A binding that renders its own DOM uses the primitives `Translate` is built on:

```ts
import { generateCustomId, isContentBlockKnown, registerContentBlock, tokenizeElement } from 'langsys-js-typescript';

const { tokens, content } = tokenizeElement(element);
const custom_id = generateCustomId('Blog', tokens);
if (!isContentBlockKnown('Blog', custom_id)) {
    const result = await registerContentBlock({ custom_id, category: 'Blog', content, tokens, label: 'Welcome post' });
    if (!result.status) console.warn('not stored', result);
}
```

`registerContentBlock` never throws. It resolves `{ status: true }` only once the server stored the block. Every other result says why ([writing.md](./writing.md)). Check `status`, not whether a result came back. On a server or before mount, render blocks as trees instead ([server-rendering.md](./server-rendering.md)).

## Decision checklist

1. Any markup in this content? No: `t()`.
2. One sentence, or several units? One: `Phrase`. Several: `Translate`.
3. Inside a `Translate`, does a run contain inline markup? Mark it `data-ls-phrase`.
4. A brand, code or address that must not translate? `translate="no"`.
5. Runtime values? Params, never text built into the content ([interpolation.md](./interpolation.md)).

| Mistake | What happens |
|---|---|
| `Translate` around a sentence with `<strong>` | Three fragments; plurals and word order can't cross them |
| `Phrase` around an article | A whole document as one phrase |
| `Translate` around a bare string | A slower `t()` that registers a block |
| A `Phrase` inside a `Translate` with no `data-ls-phrase` in the HTML | The block tokenizes through it |
| HTML inside a `t()` string | Rendered as text, never as markup |
