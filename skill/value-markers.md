# Value markers

`%name%` and params work where you author the markup. Where something else prints a value first and the SDK reads the result afterwards, such as server-rendered HTML, another SDK's page or a framework's build output, there is nothing left in the text to recognize. So the emitter **marks** each printed value, and the SDK reads the mark back as a placeholder:

```html
<p>Hello <!--ls:name-->Ana<!--/ls-->, welcome back</p>
<p>Hello <span data-ls-param="name">Ana</span>, welcome back</p>   <!-- where comments can't be written -->
```

Both register `Hello {name}, welcome back` for every user, with `name` = `Ana` as the param unless you pass `name` yourself. That's one phrase, and one that can take a plural or gendered form. What the Translation Manager shows is the plain text with the placeholder; the marker and the value are gone, in either form.

- **The value is text only.** An element inside the pair makes it ordinary markup, not a value.
- **A unit holding nothing but markers registers nothing**: there is no phrase there.
- **How a translation is written:** one that keeps each placeholder once and in order is written around the value's own node, so a later update to the value still shows. One that moves or repeats a placeholder is written as a whole sentence with the value in it.
- **In a tree for `renderBlock`**, the same marker is a comment pair: `{ comment: 'ls:name' }` … `{ comment: '/ls' }` ([server-rendering.md](./server-rendering.md)).
- **The attribute name is exported** as `VAR_PARAM_ATTR` (`data-ls-param`).

You rarely write markers by hand. Bindings' build-time transforms and the server SDKs emit them. Write them yourself only when you generate HTML that a Langsys SDK reads afterwards.

## Naming placeholders: `derivePlaceholderNames`

A build-time transform names each value from its source expression, and every Langsys SDK shares the rules. So the same expression gives the same phrase whichever SDK renders it. A name the developer writes explicitly always wins. Otherwise:

| Source expression | Name |
|---|---|
| an identifier | itself in snake_case: `userName` → `user_name` |
| a member chain | its last segment: `user.firstName` → `first_name` |
| a chain ending in `length`, `size` or `count` | the previous segment plus `_count`: `items.length` → `items_count` |
| a chain ending in `value` or `current` | the previous segment: `price.value` → `price` |
| a call with one argument | the argument's name: `formatDate(order.date)` → `date` |
| a name already taken in the phrase | prefixed with its previous segment (`a.name`, `b.name` → `a_name`, `b_name`), then suffixed `_2`, `_3` |
| anything else: arithmetic, a conditional, a template literal, a computed member, a call with several arguments | `value`, `value_2`, … |

```ts
import { derivePlaceholderNames } from 'langsys-js-typescript';

derivePlaceholderNames([
    { shape: { member: ['user', 'firstName'] } },
    { shape: { member: ['items', 'length'] } },
    { shape: { other: 'binary' } },
    { shape: { identifier: 'x' }, explicit: 'total' },
]);   // ['first_name', 'items_count', 'value', 'total']
```

Names match `[a-z][a-z0-9_]*`. `m<N>o` and `m<N>c` are reserved for `Phrase`'s markup tokens, so a value that would take one is suffixed instead. Repeats are the naming rule's to merge: a self-naming expression is one placeholder wherever it repeats, and an unnameable one is its own placeholder each time. A transform hands every expression to `derivePlaceholderNames`, in order, and merges nothing itself.

## Content that can't be named

A unit whose printed values can't be marked (a binding without its transform, a value from a variable it can't see) would register a phrase per value. Render it with `register: false` instead (`Translate`, `Phrase` or `registerBlock`). It renders from the catalog, registers nothing, and one debug notice says so. Such a block only reads, so under `requireCredentials` it never rejects.
