// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persist, setPersistStorage, type PersistStorage } from '../src/persist.js';
import { setWriteEnabled, writeEnabled } from '../src/stores.js';

/**
 * GATE-3: the write decision never survives a request or a page session.
 *
 * The decision is address-dependent and fails in both directions: one allow-listed
 * request that persisted it would write-enable every anonymous visitor after it, and
 * one anonymous request would make the allow-listed origin register nothing. So the
 * `writeEnabled` signal is a plain in-memory signal, and `persist.ts` says outright
 * never to persist it. This file pins both halves the rule names.
 */

function recordingStorage() {
    const values = new Map<string, string>();
    const writes: Array<[string, string]> = [];
    const storage: PersistStorage = {
        getItem: (k) => values.get(k) ?? null,
        setItem: (k, v) => {
            writes.push([k, v]);
            values.set(k, v);
        },
        removeItem: (k) => {
            values.delete(k);
        },
    };
    return { storage, writes };
}
// A write that could carry the decision: a key naming it, or a bare boolean value.
const carriesDecision = ([k, v]: [string, string]) => /write/i.test(k) || v === 'true' || v === 'false';

afterEach(() => {
    setPersistStorage(null);
    vi.unstubAllGlobals();
    writeEnabled.set(undefined);
});

describe('GATE-3: the write decision is never persisted', () => {
    it('recording the decision, in either direction, writes nothing that carries it', () => {
        const r = recordingStorage();
        setPersistStorage(r.storage);
        const before = r.writes.length;

        setWriteEnabled(true);
        setWriteEnabled(false);
        setWriteEnabled(true);

        expect(writeEnabled.get()).toBe(true);
        expect(r.writes.slice(before).filter(carriesDecision)).toEqual([]);
    });

    it('positive control: the same recorder and detector catch a boolean that IS persisted', () => {
        // Without this, "nothing was written" could be a recorder nothing writes to, or a
        // detector that matches nothing. The catalog cannot be the control: it is
        // `persistScoped`, so it writes nothing until init() scopes it to a project and
        // locale, and the first version of this test failed for exactly that reason.
        const r = recordingStorage();
        setPersistStorage(r.storage);
        const persisted = persist<boolean | undefined>('langsys:gate3-control', undefined);
        persisted.set(true);
        expect(r.writes.filter(carriesDecision)).toContainEqual(['langsys:gate3-control', 'true']);
    });

    it('during a server render the decision is not recorded at all', () => {
        // One process serves many requests, so a decision recorded here would outlive
        // the request that produced it.
        writeEnabled.set(undefined);
        vi.stubGlobal('window', undefined);
        setWriteEnabled(true);
        expect(writeEnabled.get()).toBeUndefined();
    });
});
