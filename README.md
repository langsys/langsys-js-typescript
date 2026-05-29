# Langsys SDK — TypeScript

Framework-agnostic TypeScript SDK for the [Langsys](https://Langsys.dev/) Translation Manager. Realtime, continuous translations with automatic token discovery — no framework required.

This is the base SDK. Framework-specific bindings (`langsys-js-svelte`, and similar packages for React / Vue / Solid that can be built on top of this) are thin wrappers that add idiomatic framework reactivity around the same core.

[![NPM License](https://img.shields.io/npm/l/all-contributors.svg?style=flat)](./LICENSE)

## What's inside

- `LangsysApp` singleton — init, locale switching, localized country/currency/locale helpers, preferred-locale detection.
- `t(phrase, category?, params?)` — the everyday translation function. The phrase is both the lookup key *and* the base-language default. Curly-brace placeholders interpolate from `params` and are compile-time type-checked.
- `tSignal: Signal<TFunction>` — reactive primitive that re-emits a fresh `t` on every translations/locale change. Framework bindings subscribe to this to drive re-renders.
- `Translate` class — wraps a DOM element, walks text + translatable attributes, registers a content block with the Translation Manager, re-translates on locale change.
- `Signal<T>` — tiny subscribe/set/update/get primitive. Compatible with Svelte's store contract by design, so the Svelte binding is nearly trivial.
- `LangsysAppAPI` — direct HTTP access if you want to bypass everything else.
- Zero runtime dependencies. Works in browsers, Node, any bundler.

## Install

```bash
npm install langsys-js-typescript
```

## Quick start

```ts
import { LangsysApp, createSignal, t } from 'langsys-js-typescript';

// 1. A reactive holder for the user's current locale. Use `createSignal` if you
//    have nothing of your own — any object with subscribe/set/update/get works.
const userLocale = createSignal('en-us');

// 2. Initialize
const response = await LangsysApp.init({
    projectid: process.env.LANGSYS_PROJECT_ID!,
    key: process.env.LANGSYS_API_KEY!,
    UserLocaleStore: userLocale,
    baseLocale: 'en-us',
    debug: false,
});

if (!response.status) console.error('Langsys init failed', response.errors);

// 3. Translate — t(phrase, category?, params?)
document.querySelector('h1')!.textContent = t('Welcome to my app', 'Home');
document.querySelector('#tagline')!.textContent = t('We translate everything', 'Marketing');

// 4. Interpolate
document.querySelector('#greeting')!.textContent =
    t('Hello, {name}!', 'Greetings', { name: 'Sarah' });

// 5. Change locale — all subscribed consumers re-translate
userLocale.set('es-es');
```

### How `t()` works

The signature is `t(phrase, category?, params?)` — the phrase comes first, the category is optional, params come last. The phrase is the lookup key. The first time `t('Welcome to my app', 'Home')` runs with a write key, Langsys registers the phrase in the Translation Manager under the "Home" category. On subsequent locale changes, the SDK fetches translations and `t()` returns the translated version. If no translation exists yet, you get back the original phrase — your base language stays visible while translations get filled in.

#### Compile-time-checked interpolation

Placeholder names are extracted from the phrase string literal via template-literal types, so missing or extra keys in `params` are TypeScript errors at the call site:

```ts
t('Hello, {name}!', 'Greetings', { name: 'Sarah' });           // OK
t('Hello, {name}!', 'Greetings', {});                          // ❌ Property 'name' missing
t('Hello, {name}!', 'Greetings', { name: 'x', extra: 'y' });   // ❌ Unknown property 'extra'
```

Allowed value types: `string | number | Date | boolean`. Dates serialize to ISO 8601.

> Future versions will swap the simple `{name}` runtime for ICU MessageFormat — adding plural / select / date formatting — without changing the public signature. Today's `t('{count} items', 'Cart', { count })` will evolve to `t('{count, plural, one {# item} other {# items}}', 'Cart', { count })`.

#### Categorization disambiguates context

```ts
t('Home', 'Main Menu');         // 'Inicio' in Spanish
t('Home', 'Home repairs');      // 'Hogar' in Spanish
```

The same phrase in different categories can have different translations. Without categorization, "Home" would only have one. Langsys's philosophy: *translate once, use everywhere* — categorize when the same phrase legitimately means different things in different parts of the app.

### API key permissions

- **Write key** (development) — new phrases and content blocks discovered as your app runs are registered automatically.
- **Read-only key** (production) — only fetches existing translations; no token creation, no content-block writes.

Detected automatically from the validation response — you don't configure this manually.

## Reactivity for frameworks

The base SDK is intentionally framework-agnostic, but it exposes the right primitives for any framework to bind to.

### Pattern: `tSignal` is the source of reactivity

`tSignal` is a `Signal<TFunction>` that re-emits a fresh closure every time translations or the loaded locale change. Subscribe and you'll be notified to re-render; read `.get()` (or call the function the signal currently holds) for the latest value.

```ts
import { tSignal } from 'langsys-js-typescript';

const unsub = tSignal.subscribe((t) => {
    // t is the current translation function — call it for the latest translations
    document.querySelector('h1')!.textContent = t('Welcome', 'Home');
});
```

### React

```tsx
import { useSyncExternalStore } from 'react';
import { tSignal, type TFunction } from 'langsys-js-typescript';

export function useT(): TFunction {
    return useSyncExternalStore(
        (notify) => tSignal.subscribe(notify),
        () => tSignal.get(),
        () => tSignal.get(),
    );
}

// In a component:
function Header() {
    const t = useT();
    return <h1>{t('Welcome, {name}!', 'Home', { name: 'Sarah' })}</h1>;
}
```

The dedicated [`langsys-js-react`](https://github.com/langsys/langsys-js-react) package ships that hook (as `useT`) plus a `<Translate>` component around the DOM `Translate` class. The snippet above is the whole binding if you'd rather not add the dependency.

### Svelte

Use the dedicated [`langsys-js-svelte`](https://github.com/langsys/langsys-js-svelte) wrapper — `Signal<T>` already satisfies Svelte's `Readable<T>` contract structurally, so the wrapper is mostly type-relabeling and a small `Writable<string>` → `Signal<string>` adapter for the user-locale store.

### Vue / Solid / anything else

The same pattern: subscribe to `tSignal` for invalidation, call the current `TFunction` for values. ~5-10 lines of binding code per framework.

## The `Translate` class

For larger blocks of HTML — articles, help text, multi-sentence markup — use `Translate` to wrap an existing DOM element. It tokenizes text nodes and translatable attributes, registers the block with the Translation Manager (so translators see your styled markup), and re-translates on locale change.

```ts
import { Translate } from 'langsys-js-typescript';

const article = document.querySelector<HTMLElement>('#article')!;
const handle = new Translate(article, { category: 'Blog', label: 'Welcome post' });

// Locale changes are picked up automatically. Call .destroy() to stop.
handle.destroy();
```

Attributes honored on contained elements:

- `placeholder`, `alt`, `title`, `aria-label`, `aria-placeholder`
- `value` on `<button>`, `<input type="submit">`, `<input type="button">`
- `<option>` text inside `<select>`
- Several validation-message `data-*` attributes
- `translate="no"` — elements marked this way (and their children) are skipped

## Server-Side Rendering

Pre-fetch translations on the server and seed them through `initialTranslations` to skip the duplicate client fetch on hydration:

```ts
await LangsysApp.init({
    projectid: env.LANGSYS_PROJECT_ID,
    key: env.LANGSYS_API_KEY,
    UserLocaleStore: userLocale,
    baseLocale: 'en-us',
    initialTranslations,                       // fetched on the server
    initialTranslationsLocale: 'es-es',
    ssrTokenStrategy: 'client',                // 'client' | 'server' | 'auto'
});
```

- `'client'` (default) — tokens discovered during SSR flush from the client after hydration.
- `'server'` — flush tokens immediately from the server.
- `'auto'` — small batches (≤5) flush from server, larger batches wait for the client.

## Detecting the user's preferred locale

```ts
// Browser — uses navigator.languages with fallback to navigator.language
const locale = LangsysApp.detectPreferredLocale();

// SSR — parse Accept-Language header
const locale = LangsysApp.detectPreferredLocale(req.headers['accept-language']);

// Match against your app's supported locales, falling back to language-only matches
const supported = (await LangsysApp.getLocalesFlat()).map((l) => l.code);
const locale = LangsysApp.detectPreferredLocale(
    req.headers['accept-language'],
    supported,
);
```

The matcher tries exact match first (`en-US`), then language-only (`en` matches `en-GB`). When you pass `supported` and none match, it falls back to the user's top preference (normalized); it returns `false` only when no preference can be determined at all.

## Localized country / currency / locale lists

```ts
const countries    = await LangsysApp.getCountries();    // [{ code, label }, ...]
const dialCodes    = await LangsysApp.getDialCodes();    // [{ country_code, dial_code, name }, ...]
const currencies   = await LangsysApp.getCurrencies();   // [{ code, name, symbol, ... }, ...]
const locales      = await LangsysApp.getLocales();      // { LanguageName: [{ code, name }] }
const localeName   = await LangsysApp.getLocaleNameWithLookup('es-es', true, 'fr-fr'); // 'espagnol'
```

## The `Signal<T>` primitive

A tiny observable value holder. Used internally by `tSignal` and by user-supplied locale stores. You can use it for your own state too, though that's not its primary purpose.

```ts
import { createSignal, getValue } from 'langsys-js-typescript';

const count = createSignal(0);
const unsub = count.subscribe((v) => console.log('count:', v));
count.set(1);
count.update((n) => n + 1);
getValue(count); // 2
unsub();
```

**Why it matters for framework bindings:** the `Signal<T>` contract is `subscribe(run): Unsubscriber; set(v); update(fn); get(): T` with subscribe-fires-immediately semantics. Svelte's store contract is the same minus `.get()`. So:

- Anything that `Signal<T>` produces is a valid Svelte `Readable<T>`.
- Svelte writables can be adapted to `Signal<T>` with a 5-line `.get()` polyfill.
- React/Vue/Solid integrations subscribe to it the same way they'd subscribe to any external store.

## Full API

```ts
import type {
    iLangsysInitConfig,
    iLangsysResponse,
    iCategories,
    iContentBlock,
    iCountryList,
    iCountryDialCode,
    iCurrencyList,
    iLocaleDefault,
    iLocaleFlat,
    iLocaleData,
    TFunction,
    TranslationParams,
    ParamPrimitive,
    ExtractParamKeys,
    ParamsFor,
    Signal,
} from 'langsys-js-typescript';
```

- `LangsysApp.init(config)` — initialize, returns an `iLangsysResponse`.
- `LangsysApp.refresh()` — force-refetch translations for the current locale.
- `LangsysApp.t` — current `TFunction` (getter; reads fresh state on every call).
- `LangsysApp.translationsLoadingPromise` — resolves when the current locale's translations are ready.
- `LangsysApp.detectPreferredLocale(header?, supported?)` — locale detection.
- `LangsysApp.getCountries(inLocale?)` / `.getCountryName(code, inLocale?)`
- `LangsysApp.getDialCodes(inLocale?)`
- `LangsysApp.getCurrencies(inLocale?)` / `.getCurrencyName(code, inLocale?)`
- `LangsysApp.getLocales(inLocale?)` / `.getLocalesFlat(inLocale?)` / `.getLocalesData(inLocale?, force?)`
- `LangsysApp.getLocaleName(code, short?, inLocale?)` / `.getLocaleNameWithLookup(...)`
- Top-level: `t`, `tSignal`, `currentlyLoadedLocale`, `sTranslations`, `LangsysAppAPI`, `Translate`, `createSignal`, `getValue`, `persist`, `interpolate`, `Logger`, `logger`, `md5`, `isEmpty`.

## License

MIT
