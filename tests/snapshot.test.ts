// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { LangsysApp } from '../src/langsys-app.js';
import {
    buildSnapshot,
    canonicalSnapshotJson,
    parseSnapshot,
    sha256Hex,
    snapshotChecksum,
    SnapshotError,
    type CatalogSnapshot,
    type SnapshotPayload,
} from '../src/snapshot.js';
import { _resetDiscoveryState } from '../src/discovery.js';
import { autoDiscovery, catalogUnavailable, currentlyLoadedLocale, sTranslations, writeEnabled } from '../src/stores.js';
import * as pure from '../src/pure.js';
import * as main from '../src/index.js';
import vectors from './fixtures/snapshot-vectors.json';

/**
 * The SNAP family against `snapshot-vectors.json`, which this repo authors for
 * the fleet. Its expected bytes and digests come from an independent encoder
 * (Python's json.dumps + hashlib, see the file's `derived_by`), so agreement
 * here is agreement between two implementations, not one checking itself.
 */

const doc = vectors as unknown as {
    rows: { id: string; document: CatalogSnapshot; canonical: string; checksum: string }[];
    refusals: { id: string; document: unknown; refuse: string }[];
    loads: { id: string; document: unknown; locale: string; expect_catalog: Record<string, unknown> }[];
};

function payloadOf(document: CatalogSnapshot): SnapshotPayload {
    const { project_id, generated_at, base_locale, locales, categories, catalog } = document;
    return { project_id, generated_at, base_locale, locales, categories, catalog };
}

describe('the vector file', () => {
    it('is whole, with every case SNAP-1 names', () => {
        expect(doc.rows.map((r) => r.id)).toEqual([
            'empty-category-map',
            'integer-like-key',
            'utf16-sort-trap',
            'u2028-and-non-ascii-raw',
            'c0-control-escaped',
            'block-with-null',
            'category-in-one-locale',
            'several-locales-sorted',
        ]);
        expect(doc.refusals.map((r) => r.refuse)).toEqual(['checksum', 'format', 'version', 'missing-member']);
        expect(doc.loads).toHaveLength(1);
    });
});

describe('SNAP-1: the canonical serialisation and checksum, byte for byte', () => {
    it.each(doc.rows.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        expect(canonicalSnapshotJson(payloadOf(row.document))).toBe(row.canonical);
        expect(snapshotChecksum(payloadOf(row.document))).toBe(row.checksum);
        expect(row.document.checksum).toBe(row.checksum);
    });

    it.each(doc.rows.map((r) => [r.id, r] as const))('%s loads', (_id, row) => {
        expect(parseSnapshot(row.document).catalog).toEqual(row.document.catalog);
        expect(parseSnapshot(JSON.stringify(row.document)).checksum).toBe(row.checksum);
    });

    it('the traps are traps: default ordering would get these rows wrong', () => {
        const integer = doc.rows.find((r) => r.id === 'integer-like-key')!;
        expect(JSON.stringify(payloadOf(integer.document))).not.toBe(integer.canonical);
        const utf16 = Object.keys(doc.rows.find((r) => r.id === 'utf16-sort-trap')!.document.catalog.en!.UI!);
        expect([...utf16].sort()).not.toEqual([...utf16].sort((a, b) => (a.codePointAt(0)! < b.codePointAt(0)! ? -1 : 1)));
    });

    it('sha256Hex agrees with node:crypto, across block boundaries and non-ASCII', () => {
        const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(119), 'é\u2028😀'.repeat(40)];
        for (const input of inputs) expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    });

    it('buildSnapshot writes the same bytes as the vectors for the same input', () => {
        const row = doc.rows.find((r) => r.id === 'category-in-one-locale')!;
        const built = buildSnapshot({
            projectId: row.document.project_id,
            baseLocale: row.document.base_locale,
            catalogs: row.document.catalog,
            categories: ['UI', 'Errors'],
            generatedAt: new Date(row.document.generated_at),
        });
        expect(built.checksum).toBe(row.checksum);
        expect(canonicalSnapshotJson(payloadOf(built))).toBe(row.canonical);
    });

    it('buildSnapshot keeps only the chosen categories, and a category a locale lacks stays absent', () => {
        const built = buildSnapshot({
            projectId: 'p',
            baseLocale: 'EN',
            catalogs: { en: { UI: { Save: 'Save' }, Admin: { Secret: 'Secret' } }, ES: { Admin: {} } },
            categories: ['UI'],
            generatedAt: new Date('2026-09-24T12:00:00.123Z'),
        });
        expect(built.catalog).toEqual({ en: { UI: { Save: 'Save' } }, es: {} });
        expect(built.locales).toEqual(['en', 'es']);
        expect(built.base_locale).toBe('en');
        expect(built.generated_at).toBe('2026-09-24T12:00:00Z');
    });
});

describe('SNAP-1 and SNAP-3: a loader refuses, naming the reason', () => {
    it.each(doc.refusals.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        let error: unknown;
        try {
            parseSnapshot(row.document);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(SnapshotError);
        expect((error as SnapshotError).reason).toBe(row.refuse);
    });

    it('text that is not JSON is refused as such', () => {
        expect(() => parseSnapshot('{nope')).toThrow(SnapshotError);
    });

    it.each(doc.loads.map((r) => [r.id, r] as const))('%s', (_id, row) => {
        expect(parseSnapshot(row.document).catalog[row.locale]).toEqual(row.expect_catalog);
    });
});

describe('SNAP-2: a snapshot loads synchronously as the preloaded catalog', () => {
    const block = doc.rows.find((r) => r.id === 'category-in-one-locale')!.document;
    const priv = () =>
        LangsysApp.Translations as unknown as {
            config: Record<string, unknown>;
            locale: string;
            lastLoaded: Record<string, number>;
            catalogFailures: Map<string, unknown>;
            catalogRequests: Map<string, unknown>;
        };
    let savedConfig: Record<string, unknown>;

    beforeEach(() => {
        sTranslations.set({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } } as never);
        currentlyLoadedLocale.set('');
        catalogUnavailable.set(false);
        savedConfig = priv().config;
        priv().lastLoaded = {};
        // The offline case records a failed fetch for this project and locale, and CACHE-2's
        // window would then skip the next test's fetch.
        priv().catalogFailures = new Map();
        priv().catalogRequests = new Map();
    });

    afterEach(() => {
        priv().config = savedConfig;
        vi.restoreAllMocks();
    });

    it('supplies its translations on the next line, with no fetch', () => {
        const fetch = vi.spyOn(LangsysAppAPI, 'getTranslations');
        expect(LangsysApp.loadSnapshot(block, 'es')).toBe(true);
        expect(LangsysApp.t('Save', 'UI')).toBe('Guardar');
        expect(currentlyLoadedLocale.get()).toBe('es');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not mutate the snapshot it was given', () => {
        const copy = JSON.parse(JSON.stringify(block));
        LangsysApp.loadSnapshot(copy, 'es');
        expect(parseSnapshot(copy).checksum).toBe(block.checksum);
    });

    it('a locale the snapshot does not hold loads nothing', () => {
        expect(LangsysApp.loadSnapshot(block, 'fr')).toBe(false);
        expect(LangsysApp.t('Save', 'UI')).toBe('Save');
    });

    it('an edited snapshot is refused, not served', () => {
        const edited = JSON.parse(JSON.stringify(block));
        edited.catalog.es.UI.Save = 'Salvar';
        expect(() => LangsysApp.loadSnapshot(edited, 'es')).toThrow(SnapshotError);
        expect(LangsysApp.t('Save', 'UI')).toBe('Save');
    });

    it('SNAP-3: the catalog is still fetched, replaces the snapshot, and supplies what it lacked', async () => {
        LangsysApp.loadSnapshot(block, 'es');
        priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
        const fetch = vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({
            status: true,
            data: { UI: { Save: 'Guardar cambios', Cancel: 'Cancelar' } },
        } as never);
        await LangsysApp.Translations.change('es');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(LangsysApp.t('Save', 'UI')).toBe('Guardar cambios');
        expect(LangsysApp.t('Cancel', 'UI')).toBe('Cancelar');
    });

    it('with the network unavailable, the snapshot keeps rendering and a phrase it lacks is source text', async () => {
        LangsysApp.loadSnapshot(block, 'es');
        priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
        vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({ status: false, errors: ['offline'] } as never);
        await LangsysApp.Translations.change('es');
        expect(LangsysApp.t('Save', 'UI')).toBe('Guardar');
        expect(LangsysApp.t('Cancel', 'UI')).toBe('Cancel');
    });

    describe('REG-13: registration is decided against the live catalog, never the snapshot', () => {
        const queue = () => (LangsysApp.Translations as unknown as { missingTokens: Array<{ token: string }> }).missingTokens;
        const posted: string[] = [];

        beforeEach(() => {
            writeEnabled.set(true);
            queue().length = 0;
            posted.length = 0;
            vi.spyOn(LangsysAppAPI, 'createTranslatableItems').mockImplementation(async (items) => {
                for (const item of items as Array<{ phrase?: string }>) posted.push(String(item.phrase));
                return { status: true } as never;
            });
        });

        afterEach(() => {
            writeEnabled.set(undefined);
            queue().length = 0;
        });

        it('a phrase the snapshot holds is still queued, and nothing is sent while the snapshot is all there is', async () => {
            LangsysApp.loadSnapshot(block, 'es');
            priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
            LangsysApp.t('Save', 'UI');
            expect(queue().map((q) => q.token)).toEqual(['Save']);
            await (LangsysApp.Translations as unknown as { updateTokens(): Promise<boolean> }).updateTokens();
            expect(posted).toEqual([]);
            // Held, not deduplicated against the snapshot: the phrase waits for the live catalog.
            expect(queue().map((q) => q.token)).toEqual(['Save']);
        });

        it('once the live catalog arrives, what it holds is dropped and what it lacks is registered', async () => {
            LangsysApp.loadSnapshot(block, 'es');
            priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
            LangsysApp.t('Save', 'UI');
            LangsysApp.t('In neither catalog', 'UI');
            vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({ status: true, write_enabled: true, data: { UI: { Save: 'Guardar' } } } as never);
            await LangsysApp.Translations.change('es');
            await (LangsysApp.Translations as unknown as { updateTokens(): Promise<boolean> }).updateTokens();
            expect(posted).toEqual(['In neither catalog']);
        });

        it('the read lane reports nothing for a phrase the snapshot holds; control: a phrase it lacks is reported', async () => {
            _resetDiscoveryState();
            window.sessionStorage.clear();
            writeEnabled.set(false);
            autoDiscovery.set(true);
            const hinted = vi.spyOn(LangsysAppAPI, 'postDiscoveryHint').mockResolvedValue({ status: true } as never);
            vi.useFakeTimers();
            try {
                LangsysApp.loadSnapshot(block, 'es');
                LangsysApp.t('Save', 'UI');
                await vi.advanceTimersByTimeAsync(31_000);
                expect(hinted).not.toHaveBeenCalled();
                LangsysApp.t('In neither catalog', 'UI');
                await vi.advanceTimersByTimeAsync(31_000);
                expect(hinted).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
                _resetDiscoveryState();
                autoDiscovery.set(undefined);
            }
        });

        it('control: with the live catalog published, a phrase it holds is not queued', async () => {
            priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
            vi.spyOn(LangsysAppAPI, 'getTranslations').mockResolvedValue({ status: true, data: { UI: { Save: 'Guardar' } } } as never);
            await LangsysApp.Translations.change('es');
            LangsysApp.t('Save', 'UI');
            expect(queue()).toEqual([]);
        });
    });

    it('control: seedCatalog, the SSR hand-off, IS the catalog of record and suppresses the fetch', async () => {
        LangsysApp.seedCatalog({ UI: { Save: 'Guardar' } } as never, 'es');
        priv().config = { ...savedConfig, projectid: 'p', key: 'k' };
        const fetch = vi.spyOn(LangsysAppAPI, 'getTranslations');
        await LangsysApp.Translations.change('es');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('surfaces', () => {
    it('the pure pieces are on /pure and the main entry, as the same objects', () => {
        for (const name of ['buildSnapshot', 'canonicalSnapshotJson', 'parseSnapshot', 'snapshotChecksum', 'SnapshotError', 'SNAPSHOT_FORMAT', 'SNAPSHOT_VERSION'] as const) {
            expect((pure as Record<string, unknown>)[name], name).toBeDefined();
            expect((pure as Record<string, unknown>)[name], name).toBe((main as Record<string, unknown>)[name]);
        }
    });
});
