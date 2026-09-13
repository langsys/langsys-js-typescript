// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Translate } from '../src/translate.js';
import { LangsysApp } from '../src/langsys-app.js';
import { sTranslations, currentlyLoadedLocale } from '../src/stores.js';
import { generateCustomId, isContentBlockKnown, resolveHistoricalBlockId } from '../src/content-block.js';
import { blockContentMatches, historicalCustomIds } from '../src/identity.js';
import rows from './fixtures/legacy-custom-id-reference.json';
import type { iCategories } from '../src/types/translations.js';

/**
 * CID-3 and CID-4: content registered by an older SDK keeps resolving, and a
 * historical id is attached only when the block stored under it holds this
 * block's content.
 *
 * The fixture is the fleet's shared legacy vector file, vendored byte-for-byte from
 * langsys-python at blob dc5556466dc54fe82e81ac9fdbf4549b2b76e7ce (langsys-php-sdk
 * carries the identical blob). The spec names it as the authoritative list of
 * historical shapes and specifies the test written here: for every row, seed a
 * catalog entry under that row's historical id and resolve the block it describes.
 *
 * Both behaviours were RED against the previous fallback before this change: a block
 * stored under a PHP pipe-join id did not resolve, and a colliding code-unit id
 * whose stored phrases differed was attached anyway.
 */

interface LegacyRow {
    category: string | null;
    tokens: string[];
    note: string;
    legacy_custom_id: string;
    pipe_join_custom_id: string | null;
}
const ROWS = rows as unknown as LegacyRow[];
const LF = String.fromCharCode(10);

const bare = (): iCategories =>
    ({ __uncategorized__: { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } }) as iCategories;
const bucketOf = (category: string | null) => category || '__uncategorized__';
function seed(bucket: string, id: string, block: Record<string, string | null>) {
    sTranslations.set({ ...bare(), [bucket]: { __category__: bucket, __symbol__: bucket, [id]: block } } as unknown as iCategories);
}
const asBlock = (tokens: string[]) => Object.fromEntries(tokens.map((t) => [t, 'T:' + t]));
const settle = () => new Promise((r) => setTimeout(r, 25));

/**
 * The lookup `Translate` performs: the current id first, then the historical ones.
 *
 * For an ASCII row the code-unit hash EQUALS the current id (the fixture's row 0
 * says so), so `historicalCustomIds` rightly leaves it out and the current-id lookup
 * is what resolves it. The first version of this file tested the historical list on
 * its own and went red on exactly the ASCII rows, which was the test being wrong
 * about the lookup, not the implementation.
 */
function lookupBlockId(category: string | null, tokens: string[]): string | null {
    const current = generateCustomId(category ?? '', tokens);
    if (isContentBlockKnown(category ?? '', current)) return current;
    return resolveHistoricalBlockId(category ?? '', historicalCustomIds(category, tokens), tokens);
}
const triedIds = (row: LegacyRow) => [generateCustomId(row.category ?? '', row.tokens), ...historicalCustomIds(row.category, row.tokens)];

beforeEach(() => {
    sTranslations.set(bare());
    currentlyLoadedLocale.set('en-us');
    LangsysApp.Translations.settle();
});

describe('the vendored fixture is the blob the spec names', () => {
    it('is byte-identical to blob dc555646, with all 20 rows', () => {
        const bytes = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'legacy-custom-id-reference.json'));
        const header = Buffer.from('blob ' + bytes.length + String.fromCharCode(0), 'utf8');
        expect(createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')).toBe(
            'dc5556466dc54fe82e81ac9fdbf4549b2b76e7ce'
        );
        expect(ROWS).toHaveLength(20);
    });
});

describe('CID-3: every historical shape in the fixture is tried', () => {
    it.each(ROWS.map((r, i) => [i, r.note.slice(0, 48), r] as const))(
        'row %i code-unit id is tried (%s)',
        (_i, _note, row) => {
            expect(triedIds(row)).toContain(row.legacy_custom_id);
        }
    );

    it.each(ROWS.filter((r) => r.pipe_join_custom_id).map((r) => [ROWS.indexOf(r), r.note.slice(0, 48), r] as const))(
        'row %i pipe-join id is tried (%s)',
        (_i, _note, row) => {
            expect(triedIds(row)).toContain(row.pipe_join_custom_id);
        }
    );

    it('for an ASCII row the code-unit id IS the current id, so it resolves there and is not listed again', () => {
        const row = ROWS[0]!;
        expect(generateCustomId(row.category ?? '', row.tokens)).toBe(row.legacy_custom_id);
        expect(historicalCustomIds(row.category, row.tokens)).not.toContain(row.legacy_custom_id);
    });

    it('never lists the current id, and never repeats one', () => {
        for (const row of ROWS) {
            const ids = historicalCustomIds(row.category, row.tokens);
            expect(ids).not.toContain(generateCustomId(row.category ?? '', row.tokens));
            expect(new Set(ids).size).toBe(ids.length);
        }
    });
});

describe('CID-3: the spec test, resolving a block seeded under each historical id', () => {
    const cases = ROWS.flatMap((row, i) => [
        [i, 'code-unit', row.legacy_custom_id, row] as const,
        ...(row.pipe_join_custom_id ? [[i, 'pipe-join', row.pipe_join_custom_id, row] as const] : []),
    ]);
    it.each(cases)('row %i resolves under its %s id', (_i, _shape, id, row) => {
        seed(bucketOf(row.category), id, asBlock(row.tokens));
        expect(lookupBlockId(row.category, row.tokens)).toBe(id);
    });
});

describe('CID-4: a historical id is attached only when its stored content matches', () => {
    it('declines the code-unit collision pair: same id, different phrases', () => {
        const a = ROWS[15]!;
        const b = ROWS[16]!;
        // The collision is real, which is what makes this a test of the guard.
        expect(a.legacy_custom_id).toBe(b.legacy_custom_id);
        seed('UI', a.legacy_custom_id, asBlock(a.tokens));
        expect(lookupBlockId('UI', b.tokens)).toBeNull();
        // Control: the block the id was actually written for does resolve. Row A is
        // ASCII, so its code-unit id is also its current id and resolves there.
        expect(lookupBlockId('UI', a.tokens)).toBe(a.legacy_custom_id);
    });

    it('declines a pipe-join id whose stored block holds different phrases', () => {
        const row = ROWS[18]!;
        seed('UI', row.pipe_join_custom_id!, {});
        expect(lookupBlockId('UI', row.tokens)).toBeNull();
    });

    it('compares as a set, since the catalog map has already lost the order', () => {
        expect(blockContentMatches(['World', 'Hello'], ['Hello', 'World'])).toBe(true);
        expect(blockContentMatches(['Hello'], ['Hello', 'World'])).toBe(false);
    });

    it('compares as normalised for hashing, so an older stored spelling still matches', () => {
        expect(blockContentMatches(['A long' + LF + '    description', 'Hi %name%'], ['A long description', 'Hi {name}'])).toBe(true);
    });
});

describe('both behaviours on the real render path', () => {
    it('a block stored under the PHP pipe-join id renders its translations', async () => {
        seed('Blog', ROWS[0]!.pipe_join_custom_id!, { Hello: 'Hola', World: 'Mundo' });
        const host = document.createElement('div');
        host.innerHTML = '<p>Hello</p><p>World</p>';
        const t = new Translate(host, { category: 'Blog' });
        await settle();
        expect(host.textContent).toContain('Hola');
        expect(host.textContent).toContain('Mundo');
        expect(host.getAttribute('data-ls-contentblock')).toBe(ROWS[0]!.pipe_join_custom_id);
        t.destroy();
    });

    it('a colliding historical id is not attached: the block keeps its own current id', async () => {
        const token = ROWS[16]!.tokens[0]!;
        seed('UI', ROWS[15]!.legacy_custom_id, { [ROWS[15]!.tokens[0]!]: 'WRONG' });
        const host = document.createElement('div');
        host.innerHTML = '<img alt="' + token + '">';
        const t = new Translate(host, { category: 'UI' });
        await settle();
        // Attaching would have stamped the foreign id and skipped registering this
        // block's own content, orphaning it for good.
        expect(host.getAttribute('data-ls-contentblock')).toBe(generateCustomId('UI', [token]));
        t.destroy();
    });
});
