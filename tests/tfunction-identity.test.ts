import { describe, expect, it } from 'vitest';
import { createSignal } from '../src/signal.js';
import { Translations } from '../src/translations.js';
import { currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import type { iCategories } from '../src/types/translations.js';
import type { TFunction } from '../src/types/translation-fn.js';

/**
 * The undocumented-in-code contract that every binding's reactivity rests on.
 *
 * `Signal.set` drops a value `Object.is`-equal to the current one, so a fresh
 * `TFunction` per emit is what tells subscribers anything happened. Memoizing
 * `buildTFn` is the obvious optimization — the closure body never varies — and
 * it silently freezes every consumer: no subscriber fires, nothing throws, and
 * `t()` still returns correct values to anyone who calls it. Nobody does,
 * because nobody re-rendered.
 *
 * Solid and Angular re-render *only* because of this. It was documented in an
 * architecture overview and nowhere near the two lines that enforce and depend
 * on it, with no test — so a refactorer would have seen a green suite.
 */

function bare(): iCategories {
    return { __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } };
}

function newTranslations() {
    return new Translations({
        projectid: 'p',
        key: 'k',
        sUserLocale: createSignal('en-us'),
        baseLocale: 'en',
    });
}

describe('tSignal emits a fresh TFunction identity every time', () => {
    it('mints a new reference on a catalog change', () => {
        const tr = newTranslations();
        const seen: TFunction[] = [];
        const unsub = tr.tSignal.subscribe((fn) => seen.push(fn));

        sTranslations.set(bare());
        sTranslations.set(bare());
        unsub();

        expect(seen.length).toBeGreaterThanOrEqual(3); // initial + two emits
        expect(new Set(seen).size).toBe(seen.length); // every one distinct
    });

    it('mints a new reference on a locale change', () => {
        const tr = newTranslations();
        const seen: TFunction[] = [];
        const unsub = tr.tSignal.subscribe((fn) => seen.push(fn));

        currentlyLoadedLocale.set('fr-fr');
        currentlyLoadedLocale.set('de-de');
        unsub();

        expect(new Set(seen).size).toBe(seen.length);
    });

    it('a subscriber is NOTIFIED, which is the property identity buys', () => {
        // The identity assertions above are the mechanism; this is the
        // consequence. If buildTFn were memoized, set() would short-circuit and
        // this counter would stop moving while the catalog kept changing.
        const tr = newTranslations();
        let notifications = 0;
        const unsub = tr.tSignal.subscribe(() => notifications++);
        const baseline = notifications;

        sTranslations.set(bare());
        sTranslations.set(bare());
        unsub();

        expect(notifications).toBe(baseline + 2);
    });

    it('control: Signal.set really does drop an identical reference', () => {
        // Without this the tests above could pass under a Signal that notified
        // unconditionally, which would make the whole contract unnecessary —
        // and they would then prove nothing about why it exists.
        const s = createSignal<{ v: number }>({ v: 1 });
        let calls = 0;
        const unsub = s.subscribe(() => calls++);
        const same = s.get();

        s.set(same);
        s.set(same);
        unsub();

        expect(calls).toBe(1); // the immediate call on subscribe, and nothing else
    });
});
