import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import api from './contract-seeds/contract-api.js';
import blockContent from './contract-seeds/contract-block-content.js';
import hintLane from './contract-seeds/contract-hint-lane.js';
import icu from './contract-seeds/contract-icu.js';
import phraseExclusion from './contract-seeds/contract-phrase-exclusion.js';
import referenceReads from './contract-seeds/contract-reference-reads.js';
import servedBlock from './contract-seeds/contract-served-block.js';
import writeLane from './contract-seeds/contract-write-lane.js';
import localeHeaders from './contract-seeds/locale-headers.js';
import requestScopeCredentials from './contract-seeds/request-scope-credentials.js';
import requestScope from './contract-seeds/request-scope.js';
import { renderSeedFile, seedFile, type SeedFile } from './contract-seeds/worlds.js';

/**
 * The seed files the SDK test clone is built from before a run (spec CONF-2) are their worlds'
 * declarations, rendered. A file that differs from its declaration fails here; write them again
 * with `npx vitest run tests/contract-seeds.test.ts -u`, and reseed the clone to take the change.
 */
const FILES: Record<string, SeedFile<string>> = {
    'contract-api': api,
    'contract-block-content': blockContent,
    'contract-hint-lane': hintLane,
    'contract-icu': icu,
    'contract-phrase-exclusion': phraseExclusion,
    'contract-reference-reads': referenceReads,
    'contract-served-block': servedBlock,
    'contract-write-lane': writeLane,
    'locale-headers': localeHeaders,
    'request-scope': requestScope,
    'request-scope-credentials': requestScopeCredentials,
};
const FOLDER = join(__dirname, 'contract-seeds');

describe('the seed files are what their worlds declare', () => {
    it.each(Object.entries(FILES))('%s.json', async (name, file) => {
        await expect(renderSeedFile(file)).toMatchFileSnapshot(`./contract-seeds/${name}.json`);
    });
});

it('the folder holds no JSON but the seed files, since the seeder reads every JSON file in it at any depth', () => {
    const json = (readdirSync(FOLDER, { recursive: true }) as string[]).filter((path) => path.endsWith('.json')).map((path) => relative(FOLDER, join(FOLDER, path)));
    expect(json.sort()).toEqual(Object.keys(FILES).map((name) => `${name}.json`).sort());
});

it('ids, raw keys and user tokens are unique across the files, inside the TypeScript core’s ranges', () => {
    const files = Object.values(FILES);
    expect(new Set(files.map((f) => f.index)).size, 'one index per file: it places the file’s ids and addresses').toBe(files.length);
    expect(new Set(files.map((f) => f.slug)).size, 'one slug per file: it names the file’s raw keys').toBe(files.length);
    const projects = files.flatMap((f) => f.document.projects) as Array<{ id: string; user: { token: string; device_id: string } }>;
    const keys = files.flatMap((f) => f.document.keys) as Array<{ id: string; key: string }>;
    const tokens = projects.map((p) => p.user.token);
    for (const [what, values] of [
        ['project id', projects.map((p) => p.id)],
        ['key id', keys.map((k) => k.id)],
        ['raw key', keys.map((k) => k.key)],
        ['token id', tokens.map((t) => t.split('|')[0])],
        ['device id', projects.map((p) => p.user.device_id)],
    ] as const) {
        expect(new Set(values).size, `every ${what} is unique`).toBe(values.length);
    }
    for (const id of [...projects, ...keys].map((r) => r.id)) expect(id).toMatch(/^7500[0-9a-f]{4}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const { key } of keys) expect(key.startsWith('ts-'), key).toBe(true);
    for (const token of tokens) {
        const id = Number(token.split('|')[0]);
        expect(id >= 100000 && id <= 109999, token).toBe(true);
    }
});

it('a world is handed out once: each case takes a fresh one, and a pool taken dry throws, naming the count to raise', () => {
    const file = seedFile('pool-check', 18, { w: { projects: { p1: { target_locales: ['es-es'] } }, keys: { k: { project: 'p1', type: 'read' } }, count: 2 } });
    const first = file.take('w');
    const second = file.take('w');
    expect(second.project()).not.toBe(first.project());
    expect(second.key('k')).not.toBe(first.key('k'));
    expect(second.address).not.toBe(first.address);
    expect(() => file.take('w')).toThrow(/holds 2 "w" worlds.*raise its count/);
});
