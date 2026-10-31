# Locales, the user's language, and the reference lists

## The SDK's locale form: lowercase `xx-yy`

Whatever form a locale arrives in, it is canonicalized where it enters: the init config, the locale store's values, API parameters. Everything the SDK hands back is lowercase: `currentlyLoadedLocale`, `localeHeaders()`, `detectPreferredLocale()` and the catalog cache key.

```ts
import { canonicalizeLocale } from 'langsys-js-typescript';

canonicalizeLocale('en_us');        // 'en-us'
canonicalizeLocale('en-US');        // 'en-us'
canonicalizeLocale('zh-Hant-TW');   // 'zh-hant-tw'
canonicalizeLocale('iw-IL');        // 'he-il'       legacy aliases resolve
canonicalizeLocale('sh-BA');        // 'sr-latn-ba'
canonicalizeLocale('en-US-POSIX');  // 'en-us-posix'  variants are kept as written, lowercased
canonicalizeLocale('es');           // 'es'          never widened
```

- **Compare in this form**, or pass both sides through `canonicalizeLocale` first. `locale === 'en-US'` is silently always false.
- **Canonicalizing isn't resolving.** It fixes case, separators and aliases, nothing more. A bare `es` is a valid tag, and the catalog request for it answers 422 on a project whose Spanish is `es-cr`. Only `detectPreferredLocale` matches a language to one of your locales. Never widen a locale with string manipulation.
- `Intl` still gets what it expects: `new Intl.Locale('zh-tw').maximize()` is `zh-Hant-TW`.

## Detecting the user's locale

```ts
LangsysApp.detectPreferredLocale();                       // navigator.languages, else navigator.language
LangsysApp.detectPreferredLocale(acceptLanguageHeader);   // a request's Accept-Language
LangsysApp.detectPreferredLocale(header, supported);      // matched against your locales

const locale = LangsysApp.detectPreferredLocale(header, ['es-cr', 'it-it', 'fr-fr', 'en-us']) || 'en-us';
```

It tries an exact match first, then the same language and script through CLDR likely-subtags data. `es-mx` and plain `es` match `es-cr`, and `fr-ca` matches `fr-fr`. `zh-tw` matches `zh-hant` but never `zh-hans`: cross-script fallbacks are refused. Results are lowercase.

- **With `supported`, no match returns `false`,** so `|| 'en-us'` reaches your default. Text that isn't a locale (`'!!!'`) returns `false` too.
- **Without `supported`, it returns the user's top preference,** and `false` only when no preference can be determined.
- **On a server, always pass the request's header.** Node 21 and later define `navigator` too, so a call with no header reads the server process's own locale, not the visitor's.

> **`supported` is the locales your project offers: its base and target locales in Langsys.** Don't build it from `LangsysApp.getLocalesFlat()`. That is the API's whole locale table, hundreds of codes, so nearly any header "matches" and the helper confidently returns something like `de-de`. Every catalog request for it then answers 422, with `The locale provided is not a base or target locale for this project` in the `Langsys` console log.

## Your own API in the user's language: `localeHeaders()`

```ts
import { localeHeaders } from 'langsys-js-typescript';

await fetch('/api/orders', { headers: { ...localeHeaders() } });   // { 'Accept-Language': 'es-es' }
```

It names the locale the user chose, or, inside a request scope, the scope's, so an API of yours that negotiates language answers in the user's. Until `LangsysApp.init()` has your locale store and outside any scope, it returns `{}`, so spread it rather than indexing it.

## The reference lists

Localized lists of countries, dial codes, currencies and locales, named in a display locale:

```ts
await LangsysApp.getCountries();       // [{ code, label, eu }, ...]
await LangsysApp.getDialCodes();       // [{ country_code, dial_code, name }, ...]: '34', 'Spain (+34)'
await LangsysApp.getCurrencies();      // [{ code, name, symbol, ... }, ...]
await LangsysApp.getLocales();         // { LanguageName: [{ code, name }] }
await LangsysApp.getLocalesFlat();     // [{ code, name }, ...]
await LangsysApp.getLocaleNameWithLookup('es-es', true, 'fr-fr');   // 'Espagnol'
await LangsysApp.getCountryName('ES');
await LangsysApp.getCurrencyName('EUR');
```

- **The display locale** is the optional last argument. Without one, it's the current locale as `t()` serves it: inside a request scope, the scope's. It's normalized as `t()` normalizes a locale, so `iw-IL` names its lists in `he-il`.
- **Locale codes in the lists come back in the API's lowercase `xx-yy` form** (`_` read as `-`), whatever format the organization writes its codes in. Country and currency codes come back as the API sends them (`ES`, `EUR`).
- **Each list is read once per display locale and held for the core's lifetime.** A country field on every page of a server costs one request per locale for the whole process. Concurrent calls share one request, and each caller gets its own copy, safe to sort or edit. `LangsysApp.getLocalesData(locale, true)` and `LangsysApp.refresh()` read the locale data again.
- **No call throws.** A failed read answers an empty list (`{}` for `getLocales`) and logs why. That list and locale aren't asked again under the same credentials until the failure window passes: 3 seconds, doubling up to 5 minutes. A display locale not shaped like a locale is refused with nothing sent.
- **Unconfigured,** the lists answer empty without a request, or reject under `requireCredentials` ([init-config.md](./init-config.md)).
- **`LangsysApp.getLocaleName(code, short?, inLocale?)` is synchronous,** reading only what `LangsysApp.getLocalesData()` or `LangsysApp.getLocaleNameWithLookup()` already loaded. Called earlier, it answers `''`. Prefer `getLocaleNameWithLookup()` unless you know the data is loaded.
