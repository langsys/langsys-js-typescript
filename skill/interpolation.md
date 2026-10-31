# Interpolation, ICU and the template tag

## `{name}` and `%name%`

Placeholders are single-brace `{name}`, filled from params:

```ts
t('Hello, {name}!', 'Greetings', { name: 'Ana' });
```

Markup handed to `Translate` or `Phrase` also accepts `%name%`. That spelling exists for **compiled** markup: a framework compiler turns `{name}` in a template into an expression before the SDK sees the text, so the SDK captures the value and registers it as part of the phrase. `%name%` survives compilation as plain text.

| Where the placeholder is written | Spelling |
|---|---|
| A `t()` string, anywhere, even inside a template | `{name}` |
| Markup a framework compiles, handed to `Translate` or `Phrase` | `%name%` |
| Hand-written HTML or DOM, as here | `{name}` or `%name%`, the same thing |

`%name%` is normalized to `{name}` when the markup is captured, so translators, the wire and the Translation Manager only ever see `{name}`, and both spellings register the same block. Only identifiers match (`%[A-Za-z_][A-Za-z0-9_]*%`), so `50% off` and `width: 100%` are never touched. A binding's skill says whether its build step changes this rule for its own templates.

## Typed params

Placeholder names are read from the phrase literal, so missing or extra params are compile errors at the call site:

```ts
t('Hello, {name}!', 'Greetings', { name: 'Ana' });            // ok
t('Hello, {name}!', 'Greetings', {});                         // ❌ 'name' is missing
t('Hello, {name}!', 'Greetings', { name: 'x', extra: 'y' });  // ❌ 'extra' is unknown
```

## Values

Param values are `string | number | Date | boolean`.

- **Numbers** format with `Intl.NumberFormat` in the catalog's locale: `1234.5` is `1.234,5` in `de-de`.
- **Dates** format with `Intl.DateTimeFormat`, medium style: `14.03.2026` in `de-de`.
- **Strings** pass through untouched. Pass an id or a code as a string to keep it free of grouping separators.

Formatting uses the catalog's locale, not the host's, so a server and a browser render the same text. A placeholder with no param stays visible as `{name}` rather than going blank.

## ICU MessageFormat

A translation in ICU syntax renders with the active locale's CLDR rules: Arabic's six plural categories, Russian's four.

```ts
t('{count, plural, one {# item} other {# items}}', 'Cart', { count });
```

`{n, number}`, `{d, date}` and `{t, time}` format too, and plain `{name}` slots keep working beside ICU.

**You don't have to write ICU to get it.** Every request carries `X-Langsys-Capabilities: icu`, so the server sends plurals and selects as ICU for `t()` to render, never flattened to one branch. Langsys can turn a plain phrase into a plural or a gendered select in a target locale while your code keeps passing the same params.

**Gender.** In a language with grammatical gender, Langsys can turn `{name}` into `{name_gender, select, …}` in the translation. Pass `name_gender` beside `name` when you know it; it's typed as an optional param for every placeholder:

```ts
t('{name} has been invited', 'Team', { name: 'Ana', name_gender: 'female' });
```

**A missing argument never blanks the text.**
- A `select` takes its `other` branch, which is why gender works without the param.
- A `plural` takes `other` and shows `#` as `{count}`.
- A plain slot stays `{name}`.
- A `null` argument counts as missing, never as zero.

`interpolate(template, params?, locale?, options?)` is the same renderer as a function (`interpolate('{n, plural, one {# item} other {# items}}', { n: 3 }, 'en-us')` is `'3 items'`). `options.onDefaulted` and `options.onFormatterFailure` hand its notices to your own logger, and `defaultedArguments(template, params)` names the arguments a render would default.

## The template tag

`t` is also a typed template tag:

```ts
t`Hello, ${{ name }}!`     // ✅ the tag: registers "Hello, {name}!", one phrase for every user
t(`Hello, ${name}!`)       // ❌ a call with a built string: one phrase per user
```

The two are one character apart and mean opposite things. The tag receives the literal's static parts and the values separately, so it can put a placeholder where each value goes.

- **Each value is a one-key object.** `${{ name }}` names the placeholder; `${name}` doesn't. A tag with any value that isn't a one-key object returns its text as written. Nothing in it is looked up, translated or registered, and only a debug notice says so.
- **The placeholder is the key in snake_case.** `` t`Hello ${{ userName }}` `` registers `Hello {user_name}`, a **different phrase** from `t('Hello {userName}', { userName })`. Pick one form per project or the catalog holds both.
- **A tag takes no category.**

The plain call, `t('Hello, {name}!', 'Greetings', { name })`, is correct everywhere. Prefer it unless the tag reads better.

## The unmatched-params warning

With `debug: true`, `Translate` and `Phrase` warn when their params have keys with no matching placeholder in the captured content. That is the fingerprint of braces a compiler consumed:

```
Langsys Warning  <Translate> received params with no matching placeholder in its
content: %count%. If you wrote {count} or {{ count }} in markup, your framework's
template compiler substituted it before Langsys saw the text — write %count% instead.
```

It treats ICU arguments as placeholders, warns again only when the params' key set changes, and is silent without `debug`. It is a safety net, not a detector: it infers from unmatched params because the original braces are already gone.

## Checking it worked

1. Run with `debug: true` in a write-enabled session, and confirm there is no unmatched-params warning.
2. Switch locale and confirm the text changes.
3. In the Translation Manager, confirm the registered phrases hold `{name}` placeholders, not values.
