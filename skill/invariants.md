# Invariants

The rules other i18n habits break. Each mistake below looks correct in the base language.

## 1. Never build a phrase

This is the one mistake that corrupts shared state. Everything else breaks one app. This writes into the Translation Manager that every SDK and teammate on the project reads, and editing the code doesn't undo it.

```ts
t(`Hello, ${name}!`);                    // ❌ one new phrase per user, forever
t('Hello, ' + name + '!');               // ❌ the same
t('Hello, {name}!', 'Greetings', { name });  // ✅ one phrase, with a placeholder
```

Each distinct value registers a new phrase, each queued to the API and billed as translatable words. The SDK can't detect it: by the time the string arrives, a built string is indistinguishable from an authored one.

**The rule is about construction, not about literals.** Passing an authored string through is correct:

```ts
t(product.description, 'Catalog');      // ✅ one phrase per product: the content you meant to translate
```

The test is **cardinality**. A CMS with 400 products registers 400 phrases, which is the point. `${name}` registers one per visitor. Where a string came from (a CMS, a database, an API, a third-party widget) doesn't matter. The app is where content converges, and translating it there is right. If you are building a string before passing it, stop. If you are passing one through, carry on.

The one template-literal form that is correct is the **tag**, `` t`Hello, ${{ name }}!` ``, which never sees a built string ([interpolation.md](./interpolation.md)).

## 2. The phrase is the key

There are no catalog files to create, no `locales/en.json`, no dot-keys:

```ts
t('Welcome back', 'Home');   // ✅ the source text is the key and the default
t('home.welcome');           // ❌ registers the literal text "home.welcome"
```

An untranslated phrase renders as itself, so the base language always reads as written. A project migrating from key files keeps them as input through `legacyKeys` ([migration.md](./migration.md)); it doesn't recreate them.

## 3. Never write a plural or a gender form

Other i18n libraries make you write each plural form. Langsys makes them. Write the sentence as it reads, with the count as a `{placeholder}`:

```ts
t('You have {count} new messages', 'Inbox', { count });                          // ✅ every language gets its own forms
t('{count, plural, one {# new message} other {# new messages}}', 'Inbox', { count });   // ❌ ICU written by hand
```

Langsys builds each language's forms from the flat phrase, the base language included, so English renders `You have 1 new message` without a branch in your code. A hand-written plural gains nothing and puts ICU syntax in front of everyone who reads or edits the phrase in the Translation Manager.

A sentence that says something different at zero is its own phrase, chosen in code, never an `=0` branch.

## 4. Phrase first, category second

```ts
t('Home', 'Main Menu');    // ✅ t(phrase, category?, params?)
t('Main Menu', 'Home');    // ❌ registers "Main Menu" as the phrase
```

Both orders typecheck when the phrase has no placeholders. The types are:

```ts
interface TFunction {
    <P extends string>(phrase: P, ...args: TArgs<P>): string;
    <P extends string>(phrase: P, category: string | CategoryRef, ...args: TArgs<P>): string;
    (strings: TemplateStringsArray, ...values: unknown[]): string;
}
```

A function you type as `TFunction` yourself, such as a test double or a wrapper, must accept the third (template-tag) call too, or be cast with `as TFunction`.

## 5. Categorize only when the same words mean different things

```ts
t('Home', 'Main Menu');      // "Inicio"
t('Home', 'Home repairs');   // "Hogar"
```

The same phrase in two categories can take two translations. Langsys translates once and reuses everywhere, so don't categorize by reflex. Name a category after the module or feature (`Account`, `Errors`, `Checkout`, `UI`).

### Moving content to another category: name the one it left

Category is part of a phrase's identity, so a call moved into a new category is new content, and Langsys would translate and charge for it again. Name the category it was registered under before, and its translations follow it:

```ts
import { inCategory } from 'langsys-js-typescript';

t('Buy now', 'Header');                                                       // before
t('Buy now', inCategory('Checkout', { previousCategory: 'Header' }));          // ✅ after: translations move with it
t('Hi {name}', inCategory('Account', { previousCategory: '' }), { name });     // it had no category before
new Translate(el, { category: 'Pricing', previousCategory: 'Home' });          // a block
new Phrase(el, { category: 'Legal', previousCategory: 'Footer' });             // a phrase
```

- **`inCategory()` goes where the category goes.** A plain object there is params, never a category.
- **Move every use of the text in that category in the same release.** One item stands for every call registering the text in a category, so the move retires it for all of them. With `debug` on, a call still rendering it in the old category is reported once.
- **Until the catalog has it under the new category, the old category's translation renders**, so the first deploy shows no source text. The new item registers as usual.
- **It is sent once, on the registration of the miss**, and is never part of an id or a key. Once the item is in the catalog under the new category, the option does nothing and can be deleted.
- **A revert is a move too.** Moving back names the category it is in now.

## 6. A block's content must not depend on runtime data

A content block's id is derived from its category and its tokens, the text it holds. So anything that changes the tokens changes the block:

```ts
el.innerHTML = `<p>Hello ${user.name}, you have ${n} items</p>`;
new Translate(el, { category: 'Dashboard' });   // ❌ one new block per name and count
```

That is rule 1 on the block path: a new block for every distinct value. Values belong in params, with the placeholder written in the markup:

```ts
el.innerHTML = '<p>Hello {name}, you have {count} items</p>';
new Translate(el, { category: 'Dashboard', params: { name: user.name, count: n } });   // ✅ one block
```

These also change the tokens, with no value in sight:

- **A list or a conditional branch.** A list that grows or a branch that appears changes the token array, and the block re-keys under a new id.
- **A value that renders empty.** Whitespace-only text nodes are dropped, so `{a} {b}` printed with empty values yields no tokens: a different block from the same markup with values in it. An empty attribute value drops its token too, while the attribute stays in the DOM.
- **An async boundary.** Content that first shows a loading state and fills in later can register the loading state, if it stays longer than the block's 500 ms settle window.

`Translate` is for static prose: marketing copy, CMS content, form labels. Text that depends on runtime data is a `t()` call with params, or a block whose printed values are marked ([value-markers.md](./value-markers.md)). To check a block, compare its token arrays (`tokenizeElement(el).tokens`), not its DOM: a removed branch can take a token without changing the visible text-node count. `Phrase` has no token array and no block id, but values still go in params there.

## 7. Locale identifiers are lowercase

Every locale the SDK hands back is lowercase `xx-yy`: `en-us`, `zh-hant-tw`. A check like `locale === 'en-US'` is silently always false. Compare in the SDK's form, or pass both sides through `canonicalizeLocale` first. Canonicalizing fixes case, separators and aliases; it never widens `es` to `es-es`. [locales.md](./locales.md)

## 8. Initialize once, and check the answer

Call `LangsysApp.init()` once, before anything translates, and check `status` on what it resolves. A refused authorization (wrong key, wrong host, an unreachable server) throws nothing. It shows only in what `init()` resolves and as a `Langsys` line in the console, and it looks like "translations don't work". [init-config.md](./init-config.md)

## 9. The server decides who writes

Registration is the server's decision for each session, sent as `write_enabled`. The key's type doesn't decide it, and an answer without the field is read-only. The entry skill `langsys` explains the decision; [writing.md](./writing.md) has the SDK's side.

## Quick reference

| Do | Don't |
|---|---|
| `t('Hello, {name}!', 'UI', { name })` | `` t(`Hello, ${name}!`) `` |
| Pass authored strings through | Build strings with `+`, template literals or `sprintf` |
| `t('You have {count} new messages', 'Inbox', { count })` | `{count, plural, …}` written by hand |
| `t(phrase, category)` | `t(category, phrase)` |
| Params for values in a block | Values printed into a block's text |
| Compare `en-us` | Compare `en-US` |
| Check `init()`'s `status` | Assume it worked |
| A `read` or `ip_write` key in public code | A `write` key in public code |
