import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from '../src/index.js';
import * as pure from '../src/pure.js';

/**
 * Every marker constant is importable from BOTH package entries, with the same value.
 *
 * Found by the Svelte lane. `CONTENT_BLOCK_MARKER_ATTR` was exported only from `/pure`
 * while `PHRASE_MARKER_ATTR` was on the main entry. A served-bytes assertion imported
 * the content-block constant from the main entry, got `undefined`, and so looked for an
 * attribute named "undefined": a check that could not fail.
 *
 * Checked on the built entries as well as the source ones, because a binding imports
 * the package and the package is `dist`. A missing `dist` fails rather than skips;
 * `npm run build` precedes `npm test`.
 */

type Entry = Record<string, unknown>;
const markerNames = (entry: Entry) => Object.keys(entry).filter((name) => name.includes('_MARKER_ATTR')).sort();

const EXPECTED = [
    'CONTENT_BLOCK_MARKER_ATTR',
    'CONTENT_BLOCK_MARKER_ATTR_LEGACY',
    'CONTENT_BLOCK_MARKER_ATTRS',
    'PHRASE_MARKER_ATTR',
    'PHRASE_MARKER_ATTR_LEGACY',
    'PHRASE_MARKER_ATTRS',
].sort();

function parity(mainEntry: Entry, pureEntry: Entry): string[] {
    return markerNames(pureEntry).flatMap((name) => {
        if (mainEntry[name] === undefined) return [`main entry is missing ${name}`];
        return JSON.stringify(mainEntry[name]) === JSON.stringify(pureEntry[name]) ? [] : [`main entry's ${name} differs from /pure's`];
    });
}

describe('marker constants are exported from both entries, with the same value', () => {
    it('/pure carries the six marker constants being checked', () => {
        expect(markerNames(pure as Entry)).toEqual(EXPECTED);
    });

    it('the source main entry exports every one', () => {
        expect(parity(main as Entry, pure as Entry)).toEqual([]);
    });

    it('the built main entry exports every one', async () => {
        const dist = join(process.cwd(), 'dist');
        const builtMain = (await import(pathToFileURL(join(dist, 'index.mjs')).href)) as Entry;
        const builtPure = (await import(pathToFileURL(join(dist, 'pure.mjs')).href)) as Entry;
        expect(markerNames(builtPure)).toEqual(EXPECTED);
        expect(parity(builtMain, builtPure)).toEqual([]);
    });

    it('the parity check can fail: a missing constant, or a different value, is reported', () => {
        const { CONTENT_BLOCK_MARKER_ATTR: _dropped, ...withoutOne } = main as Entry;
        expect(parity(withoutOne, pure as Entry)).toEqual(['main entry is missing CONTENT_BLOCK_MARKER_ATTR']);
        expect(parity({ ...(main as Entry), PHRASE_MARKER_ATTR: 'data-other' }, pure as Entry)).toEqual([
            "main entry's PHRASE_MARKER_ATTR differs from /pure's",
        ]);
    });
});
