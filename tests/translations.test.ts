import { beforeEach, describe, expect, it } from 'vitest';
import { Translations } from '../src/translations.js';
import { sTranslations, currentlyLoadedLocale } from '../src/stores.js';
import { createSignal } from '../src/signal.js';

// Construct without touching sTranslations — callers seed it directly.
function newTranslations(opts: { keyType?: 'read' | 'write' } = {}) {
    return new Translations({
        projectid: 'test-project',
        key: 'test-key',
        sUserLocale: createSignal('en'),
        baseLocale: 'en',
        debug: false,
        key_type: opts.keyType ?? 'read', // read by default → missingToken is a no-op
    });
}

function resetStores(): void {
    sTranslations.set({
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
    });
    currentlyLoadedLocale.set('en');
}

describe('Translations.t — flat lookup', () => {
    beforeEach(resetStores);

    it('returns the translated value when present in cats[cat][phrase]', () => {
        sTranslations.set({
            UI: { __category__: 'UI', __symbol__: 'UI', Save: 'Guardar' },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        const t = newTranslations().t;
        expect(t('Save', 'UI')).toBe('Guardar');
    });

    it('returns the phrase as fallback when no translation exists', () => {
        const t = newTranslations().t;
        // Read-only key: missingToken queue is a no-op so this is safe to assert
        // without HTTP fake setup.
        expect(t('Brand new phrase', 'UI')).toBe('Brand new phrase');
    });

    it('reads fresh state from sTranslations on every call (invariant)', () => {
        const t = newTranslations().t;
        expect(t('Save', 'UI')).toBe('Save'); // not yet cached
        sTranslations.set({
            UI: { __category__: 'UI', __symbol__: 'UI', Save: 'Guardar' },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        expect(t('Save', 'UI')).toBe('Guardar'); // updated mid-flight
    });

    it('routes empty category to __uncategorized__ bucket for lookup', () => {
        sTranslations.set({
            __uncategorized__: {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
                'Welcome to my testbed': 'Bienvenido a mi banco de pruebas',
            },
        });
        const t = newTranslations().t;
        expect(t('Welcome to my testbed')).toBe('Bienvenido a mi banco de pruebas');
    });
});

describe('Translations.t — ICU rendering through interpolate', () => {
    beforeEach(resetStores);

    it('renders ICU plural at runtime via interpolate(template, params, locale)', () => {
        sTranslations.set({
            ProductCard: {
                __category__: 'ProductCard',
                __symbol__: 'ProductCard',
                'Based on {n} reviews': '{n, plural, one {Based on # review} other {Based on # reviews}}',
            },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        const t = newTranslations().t;
        expect(t('Based on {n} reviews', 'ProductCard', { n: 1 })).toBe('Based on 1 review');
        expect(t('Based on {n} reviews', 'ProductCard', { n: 5 })).toBe('Based on 5 reviews');
    });

    it('renders flat translations through simple interpolation', () => {
        sTranslations.set({
            Greetings: {
                __category__: 'Greetings',
                __symbol__: 'Greetings',
                'Hello, {name}!': 'Hola, {name}!',
            },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        const t = newTranslations().t;
        expect(t('Hello, {name}!', 'Greetings', { name: 'Humberto' })).toBe('Hola, Humberto!');
    });

    it('uses currentlyLoadedLocale at the time t() is called (plural rules)', () => {
        sTranslations.set({
            ProductCard: {
                __category__: 'ProductCard',
                __symbol__: 'ProductCard',
                'Based on {n} reviews': '{n, plural, one {Based on # review} other {Based on # reviews}}',
            },
            __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
        });
        const t = newTranslations().t;

        // Sanity check: in 'en', `2` is "other" with Latin digit.
        expect(t('Based on {n} reviews', 'ProductCard', { n: 2 })).toBe('Based on 2 reviews');

        // Switch to ar-sa and call t() again — formatter now uses Arabic
        // plural rules AND Arabic-Indic digits (٢ for 2, ٥ for 5). Confirms
        // that interpolate() reads currentlyLoadedLocale fresh on each call.
        currentlyLoadedLocale.set('ar-sa');
        expect(t('Based on {n} reviews', 'ProductCard', { n: 2 })).toBe('Based on ٢ reviews');
        expect(t('Based on {n} reviews', 'ProductCard', { n: 1 })).toBe('Based on ١ review');
    });
});
