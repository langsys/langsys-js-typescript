import { describe, expect, it } from 'vitest';
import { derivePlaceholderNames, snakeCase, type NamedExpression } from '../src/var-names.js';
import vectors from './fixtures/var-naming-vectors.json';

/**
 * VAR-2: placeholder names from source expressions, against the shared naming
 * vectors this repo authors. The expectations are written from the spec's table,
 * not from this implementation, so the file is also what every binding's own
 * naming is held to.
 */

type Case = { id: string; expressions: NamedExpression[]; names: string[] };
const cases = (vectors as unknown as { cases: Case[] }).cases;

describe('the naming vectors', () => {
    it('cover every row of the table, collisions and the unnameable cases included', () => {
        const ids = cases.map((c) => c.id);
        for (const id of ['identifier', 'member-last', 'member-length', 'member-value', 'call-one-arg', 'collision-prev', 'unnameable-twice', 'explicit-wins', 'reserved']) {
            expect(ids).toContain(id);
        }
        expect(new Set(ids).size).toBe(ids.length);
    });

    it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, row) => {
        expect(derivePlaceholderNames(row.expressions)).toEqual(row.names);
    });

    it('every expected name meets the grammar', () => {
        for (const row of cases) for (const name of row.names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    });
});

describe('snakeCase', () => {
    it.each([
        ['firstName', 'first_name'],
        ['URLPath', 'url_path'],
        ['already_snake', 'already_snake'],
        ['_private', 'private'],
        ['2fast', 'fast'],
        ['$', null],
    ])('%s → %s', (input, expected) => {
        expect(snakeCase(input)).toBe(expected);
    });
});
