# Migrating from i18n keys, and catalog snapshots

## `legacyKeys`: keep the key files during a migration

An app on i18next or vue-i18n moves to Langsys without rewriting its call sites. Keep the **source-language** file, delete every other language's file, and hand the kept file to `init()`:

```ts
import en from './locales/en.json';

await LangsysApp.init({
    projectid, key, UserLocaleStore,
    legacyKeys: [{ name: 'locales/en.json', format: 'vue-i18n', data: en }],
});

t('checkout.submit');   // → "Pay now", registered under category "checkout"
t('Welcome back!');     // not a key: literal source text, as always
```

`t()` resolves its argument as a key **first**. On a hit, the key's value is the phrase, and **the key itself never reaches Langsys**. So a later codemod can inline the source text and delete the file without moving an id. The key's first segment is the category unless the call passes one.

Each file is a `LegacyKeyFile`:
- `name`: what errors and warnings report;
- `format`: `'i18next'`, `'vue-i18n'` or `'plain'`, the default;
- `data`: the parsed file;
- `namespace`: optional; the file then answers only keys under that prefix, with the namespace as their category.

With several files, the first that holds a key answers.

Values are converted to Langsys syntax as they are read:

- **Placeholders**, in every format: `{{name}}`, `:name`, `%{name}` and `%(name)s` become `{name}`, and `%%` is a literal `%`.
- **Plurals**, by format:
  - `vue-i18n`: `car | cars` becomes `{count, plural, =1 {car} other {cars}}`, and three forms add `=0`.
  - `i18next`: `items_one` / `items_other` become one plural under `items`, by CLDR category. The older `items` / `items_plural` pair works too.
  - `plain`: no plurals, so a `|` is text.

  A plural's argument is `count`, so pass `{ count }` in params.
- **What the conversion can't express** registers exactly as written, and a warning names the file and key: a `|` in a `plain` file, `:Name`, or a formatted `%(amount).2f`.

**Other formats are refused.** `laravel`, `rails-i18n`, `gettext`, or a file named `.php`, `.yml`, `.po` or `.mo`: `init()` throws `LegacyFormatError`, naming the format and the file. Those belong to other SDKs' migration paths.

**It is a migration tool, not a permanent mode.** Leave `legacyKeys` unset once the migration is done, and `t()` does no key lookup at all.

A server or a framework bridge that reads its own files converts through the same code, so it registers the same phrase. `createLegacyKeys(files)`, `convertLegacyValue`, `convertLegacyPluralForms` and `convertLegacyCall` are exported from the main entry and from `langsys-js-typescript/pure`.

## Catalog snapshots

A snapshot is a project's catalog for chosen locales and categories, exported to a file in the `langsys-catalog-snapshot` format, which every Langsys SDK's export tool writes. A mobile bundle, a first paint or an offline session renders translations from it without calling the API.

```ts
import snapshot from './langsys-snapshot.json';

LangsysApp.loadSnapshot(snapshot);   // before the first render; false if it has no catalog for the locale
t('Save', 'UI');                     // → "Guardar", on the next line
```

- **The locale** is the user's current one, else the snapshot's base locale. Or pass it as the second argument.
- **A snapshot is a cache, not the catalog of record.** `init()` still fetches the catalog, which replaces it and supplies any phrase it lacked. Registration waits for that live catalog: nothing is registered, or skipped, on a snapshot's say-so. With no network the snapshot keeps rendering, and anything it lacks shows its source text.
- **Never edit a snapshot by hand; export it again.** Its checksum covers the contents, so an edited file is refused with `SnapshotError`, as are a different format, an unsupported version and a missing member.

`buildSnapshot({ projectId, baseLocale, catalogs, categories })` writes the format for an export tool of your own, and `parseSnapshot(input)` reads and checks one. Both are on `langsys-js-typescript/pure` too, with `SnapshotError`, `SNAPSHOT_FORMAT` and `SNAPSHOT_VERSION`.
