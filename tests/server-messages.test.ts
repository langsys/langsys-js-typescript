import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';
import {
    DEFAULT_SERVER_MESSAGE_CATEGORY,
    SERVER_MESSAGE_CODES,
    fillTemplate,
    resolveServerMessages,
    templateMarkers,
    type ServerMessage,
} from '../src/server-messages.js';
import { config as configStore, currentlyLoadedLocale, sTranslations } from '../src/stores.js';
import * as pure from '../src/pure.js';
import * as main from '../src/index.js';
import vectors from './fixtures/server-message-vectors.json';

/**
 * The MSG family against `server-message-vectors.json`, which this repo authors
 * for the fleet: marker extraction, `fill`, finding entries in a body, rendering
 * with its fallbacks, and langsys4's wire examples as canonical entries.
 */

interface RenderRow {
    id: string;
    locale: string;
    category: string;
    catalog: Record<string, Record<string, string>> | null;
    entry: ServerMessage;
    expected: string;
}

const doc = vectors as unknown as {
    markers: { id: string; template: string; expected: string[] }[];
    fill: { id: string; template: string; params: Record<string, unknown>; expected: string }[];
    resolve: { id: string; body: unknown; key?: string; expected: ServerMessage[] }[];
    render: RenderRow[];
    canonical_entries: ServerMessage[];
};

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

const queued = () =>
    (LangsysApp.Translations as unknown as { missingTokens: Array<{ token: string; category: string }> }).missingTokens;

let savedCategory: string | undefined;

beforeEach(() => {
    savedCategory = configStore.messagesCategory;
    queued().length = 0;
});

afterEach(() => {
    configStore.messagesCategory = savedCategory;
    queued().length = 0;
    publish(null, configStore.baseLocale);
});

describe('the vector file is whole', () => {
    it('every section carries its rows', () => {
        expect(doc.markers).toHaveLength(11);
        expect(doc.fill).toHaveLength(10);
        expect(doc.resolve).toHaveLength(12);
        expect(doc.render).toHaveLength(10);
        expect(doc.canonical_entries).toHaveLength(4);
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

    it.each(doc.canonical_entries.map((e) => [e.code, e] as const))(
        'canonical entry %s: message is its template filled',
        (_code, entry) => {
            expect(fillTemplate(entry.template, entry.params ?? {})).toBe(entry.message);
        }
    );

    it('an entry whose template has no marker carries no params', () => {
        const markerless = doc.canonical_entries.filter((e) => templateMarkers(e.template).length === 0);
        expect(markerless.length).toBeGreaterThan(0);
        for (const entry of markerless) expect(entry.params).toBeUndefined();
    });
});

describe('MSG-1: entries resolve wherever they sit', () => {
    it.each(doc.resolve.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        expect(resolveServerMessages(row.body, row.key ? { key: row.key } : {})).toEqual(row.expected);
    });

    it('the JSON text of a body resolves like the body', () => {
        const row = doc.resolve.find((r) => r.id === 'langsys-envelope-validation')!;
        expect(resolveServerMessages(JSON.stringify(row.body))).toEqual(row.expected);
        expect(resolveServerMessages('not json')).toEqual([]);
    });

    it('the canonical entries render identically from the default envelope and from a resolver over a foreign body', () => {
        const pw = doc.canonical_entries.filter((e) => e.field === 'password');
        const langsys = { status: false, error: { code: 'validation_failed', message: 'x', template: 'x', errors: pw } };
        const foreign = { failures: pw.map((e) => ({ path: e.field, slug: e.code, text: e.message, source: e.template, values: e.params })) };
        const resolver = (body: unknown) =>
            (body as typeof foreign).failures.map((f) => ({ field: f.path, code: f.slug, message: f.text, template: f.source, params: f.values }));

        publish({ Errors: { [pw[0]!.template]: 'La contraseña debe tener al menos {min} caracteres.' } }, 'es');
        const fromDefault = resolveServerMessages(langsys).filter((e) => e.field).map((e) => LangsysApp.renderServerMessage(e));
        const fromResolver = resolveServerMessages(foreign, { resolver }).map((e) => LangsysApp.renderServerMessage(e));
        expect(fromResolver).toEqual(fromDefault);
        expect(fromDefault).toEqual(['La contraseña debe tener al menos 12 caracteres.', pw[1]!.message]);
    });

    it("a resolver's output goes through the same entry check", () => {
        expect(resolveServerMessages({}, { resolver: () => [{ code: 'required', message: 'No template.' }] })).toEqual([]);
        expect(resolveServerMessages({}, { resolver: () => null })).toEqual([]);
    });

    it('a cyclic body terminates', () => {
        const body: Record<string, unknown> = { errors: [{ code: 'invalid', message: 'Bad.', template: 'Bad.' }] };
        body.self = body;
        expect(resolveServerMessages(body)).toHaveLength(1);
    });
});

describe('MSG-5 and MSG-6: rendering', () => {
    it.each(doc.render.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        publish(row.catalog, row.locale);
        expect(LangsysApp.renderServerMessage(row.entry, row.category)).toBe(row.expected);
    });

    it('the template is the lookup key, never the message', () => {
        const entry = doc.canonical_entries.find((e) => e.code === 'too_short')!;
        publish({ Errors: {} }, 'es');
        const t = vi.spyOn(LangsysApp.Translations, 'lookup');
        LangsysApp.renderServerMessage(entry);
        expect(t.mock.calls.map((c) => c[0])).toEqual([entry.template]);
        t.mockRestore();
    });

    it('with nothing configured the category is Errors', () => {
        configStore.messagesCategory = undefined;
        const entry = doc.canonical_entries.find((e) => e.code === 'mismatch')!;
        publish({ Errors: { [entry.template]: 'No coincide.' } }, 'es');
        expect(DEFAULT_SERVER_MESSAGE_CATEGORY).toBe('Errors');
        expect(LangsysApp.renderServerMessage(entry)).toBe('No coincide.');
    });

    it('a configured category is the one rendered under, and Errors then misses', () => {
        configStore.messagesCategory = 'Validation';
        const entry = doc.canonical_entries.find((e) => e.code === 'mismatch')!;
        publish({ Errors: { [entry.template]: 'No coincide.' } }, 'es');
        expect(LangsysApp.renderServerMessage(entry)).toBe(entry.message);
        publish({ Validation: { [entry.template]: 'No coincide.' } }, 'es');
        expect(LangsysApp.renderServerMessage(entry)).toBe('No coincide.');
    });
});

describe('MSG-2: the code vocabulary', () => {
    it('is the spec’s twenty-one slugs, in its order, ending with the text-only fallback', () => {
        expect(SERVER_MESSAGE_CODES).toHaveLength(21);
        expect(SERVER_MESSAGE_CODES[0]).toBe('required');
        expect(SERVER_MESSAGE_CODES.at(-1)).toBe('invalid');
        for (const code of SERVER_MESSAGE_CODES) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
    });
});

describe('surfaces', () => {
    it('the pure pieces are on /pure and the main entry, as the same objects', () => {
        for (const name of ['fillTemplate', 'resolveServerMessages', 'templateMarkers', 'toServerMessage', 'SERVER_MESSAGE_CODES'] as const) {
            expect((pure as Record<string, unknown>)[name]).toBeDefined();
            expect((pure as Record<string, unknown>)[name]).toBe((main as Record<string, unknown>)[name]);
        }
    });

    it('renderServerMessage is on the main entry only, since it needs t()', () => {
        expect(typeof main.renderServerMessage).toBe('function');
        expect((pure as Record<string, unknown>).renderServerMessage).toBeUndefined();
    });
});
