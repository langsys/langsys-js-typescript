import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    type ResolveServerMessagesOptions,
    type ServerMessage,
} from '../src/server-messages.js';
import { config as configStore, currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import * as pure from '../src/pure.js';
import * as main from '../src/index.js';
import vectors from './fixtures/server-message-vectors.json';

/**
 * The MSG family against `server-message-vectors.json`, which this repo authors
 * for the fleet from real framework messages: marker extraction, `fill`,
 * resolving entries from each framework's own error body through configuration,
 * and rendering with its fallbacks.
 */

interface CanonicalEntry extends ServerMessage {
    framework: string;
    source: string;
}

const doc = vectors as unknown as {
    canonical_entries: CanonicalEntry[];
    markers: { id: string; template: string; expected: string[] }[];
    fill: { id: string; template: string; params: Record<string, unknown>; expected: string }[];
    resolve: { id: string; body: unknown; options: ResolveServerMessagesOptions; expected: ServerMessage[]; body_unchanged?: boolean }[];
    render: {
        id: string;
        locale: string;
        category: string;
        catalog: Record<string, Record<string, string>> | null;
        entry: ServerMessage;
        expected: string;
    }[];
};

const wire = ({ framework: _f, source: _s, ...entry }: CanonicalEntry): ServerMessage => entry;

function publish(catalog: Record<string, Record<string, string>> | null, locale: string) {
    const categories: Record<string, Record<string, string>> = {
        __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' },
    };
    for (const [category, entries] of Object.entries(catalog ?? {})) {
        categories[category] = { __category__: category, __symbol__: category, ...entries };
    }
    sTranslations.set(categories as never);
    currentlyLoadedLocale.set(locale);
}

let savedCategory: string | undefined;

beforeEach(() => {
    savedCategory = configStore.messagesCategory;
});

afterEach(() => {
    configStore.messagesCategory = savedCategory;
    publish(null, configStore.baseLocale);
    vi.restoreAllMocks();
});

describe('the vector file', () => {
    it('is whole', () => {
        expect(doc.canonical_entries).toHaveLength(12);
        expect(doc.markers).toHaveLength(13);
        expect(doc.fill).toHaveLength(10);
        expect(doc.resolve).toHaveLength(10);
        expect(doc.render).toHaveLength(12);
    });

    it('its canonical entries are real messages from five frameworks, none privileged', () => {
        const frameworks = new Set(doc.canonical_entries.map((e) => e.framework.split(' ')[0]));
        expect(frameworks).toEqual(new Set(['Laravel', 'Pydantic', 'Django', 'ActiveModel']));
        expect(doc.canonical_entries.some((e) => e.framework.startsWith('Django REST'))).toBe(true);
        for (const entry of doc.canonical_entries) expect(entry.source, entry.template).toBeTruthy();
    });
});

describe('MSG-3: marker extraction', () => {
    it.each(doc.markers.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        expect(templateMarkers(row.template)).toEqual(row.expected);
    });
});

describe('MSG-4: fill', () => {
    it.each(doc.fill.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        expect(fillTemplate(row.template, row.params)).toBe(row.expected);
    });

    it.each(doc.canonical_entries.map((e) => [`${e.framework.split(' ')[0]} ${String(e.code)}`, e] as const))(
        'canonical entry %s: message is its template filled',
        (_label, entry) => {
            expect(fillTemplate(entry.template!, entry.params ?? {})).toBe(entry.message);
        }
    );

    it('an entry whose template has no marker carries no params, and equals its message', () => {
        const markerless = doc.canonical_entries.filter((e) => templateMarkers(e.template!).length === 0);
        expect(markerless.length).toBeGreaterThan(0);
        for (const entry of markerless) {
            expect(entry.params).toBeUndefined();
            expect(entry.template).toBe(entry.message);
        }
    });
});

describe('MSG-1 and MSG-2: entries resolve through configuration, from the framework’s own body', () => {
    it.each(doc.resolve.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        const before = JSON.stringify(row.body);
        expect(resolveServerMessages(row.body, row.options)).toEqual(row.expected);
        if (row.body_unchanged) expect(JSON.stringify(row.body)).toBe(before);
    });

    it('with no key and no resolver there is nowhere to look, and it says so', () => {
        const body = doc.resolve[0]!.body;
        expect(() => resolveServerMessages(body, {} as ResolveServerMessagesOptions)).toThrow(/key.*resolver|resolver.*key/);
    });

    it('the JSON text of a body resolves like the body', () => {
        const row = doc.resolve.find((r) => r.id === 'laravel-422-body')!;
        expect(resolveServerMessages(JSON.stringify(row.body), row.options)).toEqual(row.expected);
        expect(resolveServerMessages('not json', row.options)).toEqual([]);
    });

    it("a resolver's output goes through the same entry check", () => {
        expect(resolveServerMessages({}, { resolver: () => [{ code: 'Required', field: 'email' }] })).toEqual([]);
        expect(resolveServerMessages({}, { resolver: () => null })).toEqual([]);
    });

    it('the canonical entries render identically from two frameworks’ native bodies, resolved through configuration', () => {
        const laravel = doc.resolve.find((r) => r.id === 'laravel-422-body')!;
        const rails = doc.resolve.find((r) => r.id === 'rails-body-renamed-pieces')!;
        // The same Laravel entries attached to a Rails-shaped body under Rails' piece names.
        const pieces = rails.options.pieces!;
        const railsShaped = {
            errors: {},
            i18n: laravel.expected.map((e) =>
                Object.fromEntries(Object.entries(e).map(([piece, value]) => [pieces[piece as keyof typeof pieces] ?? piece, value]))
            ),
        };
        publish({ Errors: { [laravel.expected[0]!.template!]: 'El campo contraseña debe tener al menos {min} caracteres.' } }, 'es');
        const fromLaravel = resolveServerMessages(laravel.body, laravel.options).map((e) => LangsysApp.renderServerMessage(e));
        const fromRails = resolveServerMessages(railsShaped, { key: 'i18n', pieces }).map((e) => LangsysApp.renderServerMessage(e));
        expect(fromRails).toEqual(fromLaravel);
        expect(fromLaravel).toEqual(['El campo contraseña debe tener al menos 12 caracteres.', laravel.expected[1]!.message]);
    });

    it('MSG-2: field and code are the framework’s own, passed through unchanged, and a framework with none carries none', () => {
        const fastapi = doc.resolve.find((r) => r.id === 'fastapi-422-body')!;
        const [first] = resolveServerMessages(fastapi.body, fastapi.options);
        expect(first!.field).toEqual(['name']);
        expect(first!.code).toBe('string_too_short');
        const none = doc.resolve.find((r) => r.id === 'no-code-where-framework-has-none')!;
        expect(resolveServerMessages(none.body, none.options)[0]).not.toHaveProperty('code');
    });
});

describe('MSG-5 and MSG-6: rendering', () => {
    it.each(doc.render.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        publish(row.catalog, row.locale);
        expect(LangsysApp.renderServerMessage(row.entry, row.category)).toBe(row.expected);
    });

    it('the template is the lookup key, never the message', () => {
        const entry = wire(doc.canonical_entries[1]!);
        publish({ Errors: {} }, 'es');
        const lookup = vi.spyOn(LangsysApp.Translations, 'lookup');
        LangsysApp.renderServerMessage(entry);
        expect(lookup.mock.calls.map((c) => c[0])).toEqual([entry.template]);
    });

    it('an entry with no template is not looked up, by any path', () => {
        // A catalog that translates the message under every category a stray
        // lookup could use: were the message looked up, it would come back translated.
        publish({ Errors: { 'Something went wrong.': 'Algo salió mal.' }, __uncategorized__: { 'Something went wrong.': 'Algo salió mal.' } }, 'es');
        const lookup = vi.spyOn(LangsysApp.Translations, 'lookup');
        const tGetter = vi.spyOn(LangsysApp.Translations, 't', 'get');
        const signalGet = vi.spyOn(LangsysApp.Translations.tSignal, 'get');
        expect(LangsysApp.renderServerMessage({ message: 'Something went wrong.' })).toBe('Something went wrong.');
        expect(lookup).not.toHaveBeenCalled();
        expect(tGetter).not.toHaveBeenCalled();
        expect(signalGet).not.toHaveBeenCalled();
    });

    it('an entry with a template and no message falls back to its template filled', () => {
        publish({ Errors: {} }, 'es');
        expect(LangsysApp.renderServerMessage({ template: 'At least {min} characters.', params: { min: 3 } })).toBe('At least 3 characters.');
    });

    it('with nothing configured the category is Errors', () => {
        configStore.messagesCategory = undefined;
        const entry = wire(doc.canonical_entries[0]!);
        publish({ Errors: { [entry.template!]: 'El campo contraseña es obligatorio.' } }, 'es');
        expect(DEFAULT_SERVER_MESSAGE_CATEGORY).toBe('Errors');
        expect(LangsysApp.renderServerMessage(entry)).toBe('El campo contraseña es obligatorio.');
    });

    it('a configured category is the one rendered under, and Errors then misses', () => {
        configStore.messagesCategory = 'Validation';
        const entry = wire(doc.canonical_entries[0]!);
        publish({ Errors: { [entry.template!]: 'El campo contraseña es obligatorio.' } }, 'es');
        expect(LangsysApp.renderServerMessage(entry)).toBe(entry.message);
        publish({ Validation: { [entry.template!]: 'El campo contraseña es obligatorio.' } }, 'es');
        expect(LangsysApp.renderServerMessage(entry)).toBe('El campo contraseña es obligatorio.');
    });
});

describe('surfaces', () => {
    it('the pure pieces are on /pure and the main entry, as the same objects', () => {
        for (const name of ['fillTemplate', 'resolveServerMessages', 'templateMarkers', 'toServerMessage', 'DEFAULT_SERVER_MESSAGE_CATEGORY'] as const) {
            expect((pure as Record<string, unknown>)[name]).toBeDefined();
            expect((pure as Record<string, unknown>)[name]).toBe((main as Record<string, unknown>)[name]);
        }
    });

    it('no code vocabulary is exported: codes are the framework’s own', () => {
        expect((main as Record<string, unknown>).SERVER_MESSAGE_CODES).toBeUndefined();
        expect((pure as Record<string, unknown>).SERVER_MESSAGE_CODES).toBeUndefined();
    });

    it('renderServerMessage is on the main entry only, since it needs t()', () => {
        expect(typeof main.renderServerMessage).toBe('function');
        expect((pure as Record<string, unknown>).renderServerMessage).toBeUndefined();
    });
});
