import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CONF-2: evidence is graded, and the grade is recorded. This is the test that
 * makes "recorded" checkable instead of a promise.
 *
 * It runs `_dev_/tally-conformance.mjs --structure-only` in a child process. The
 * structure check needs no spec checkout, so it runs in CI and never skips: a check
 * that skips where it is automated is an assertion that cannot fail. The spec-derived
 * half (every one of the 79 ids present, n/a profiles checked against the rules'
 * Profiles lines) runs by hand with `npm run tally:conformance`, for the same reason
 * `verify:spec` does.
 *
 * ONE implementation of the checker, exercised two ways. A TypeScript copy of the
 * rules in this file would agree with the script until one of them changed, which is
 * the drift this project keeps paying for.
 *
 * The planted defects are the controls, and they matter more than the green line on
 * the real file. A checker that accepts everything would make that line pass forever.
 * Each defect below is a class this file has actually contained, or a form the
 * canonical format forbids:
 * an `implemented` row with a `mock` tier (twelve of those went through several review
 * rounds), ranged and compound rule cells, an off-vocabulary status, and an em dash
 * where the tier column needs a hyphen.
 */

const SCRIPT = join(process.cwd(), '_dev_', 'tally-conformance.mjs');
const EM_DASH = String.fromCharCode(0x2014);

function run(args: string[]): { code: number; out: string } {
    try {
        const out = execFileSync(process.execPath, [SCRIPT, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
    }
}

const HEADER = [
    '| | |',
    '|---|---|',
    '| **Profiles** | all, browser |',
    '| **Spec revision read** | langsys2 5cff03a1, docs/sdk-spec.mdx blob 5c5c0723f88fb8e6b13f58876c7adca8b6b35691 |',
    '',
    '| Rule | Status | Tier | Evidence |',
    '|---|---|---|---|',
];

// Not green on purpose: a provisional and a partial row. --structure-only must still
// exit 0, because a sound file full of honest provisional rows is correct.
const GOOD = [
    '| CAT-1 | implemented | n/a (pure) | `translations` lookup suite. |',
    '| GATE-1 | provisional | mock | `grant-lane` capability. Waits on: CONF-2 shared contract fixture. |',
    '| GATE-3 | partial | - | No test yet. |',
    '| HINT-2 | n/a (profile: server) | - | Profile server. |',
];

function writeDoc(rows: string[], header: string[] = HEADER): string {
    const dir = mkdtempSync(join(tmpdir(), 'langsys-conformance-'));
    const path = join(dir, 'CONFORMANCE.md');
    writeFileSync(path, [...header, ...rows].join('\n') + '\n');
    return path;
}

const replaceRow = (index: number, row: string) => GOOD.map((r, i) => (i === index ? row : r));

describe('CONF-2: the committed CONFORMANCE.md is structurally valid', () => {
    it('passes the canonical structure check', () => {
        const r = run(['--structure-only']);
        expect(r.out, r.out).not.toContain('STRUCTURAL ERRORS');
        expect(r.code, r.out).toBe(0);
    });
});

describe('the checker can fail, for each class of defect', () => {
    it('a clean file passes, even though it is not green', () => {
        const r = run(['--structure-only', '--file', writeDoc(GOOD)]);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain('NOT GREEN');
    });

    it.each([
        ['implemented carrying a mock tier', replaceRow(0, '| CAT-1 | implemented | mock | `translations` lookup suite. |'), 'cannot carry tier "mock"'],
        ['a duplicated rule id', [...GOOD, '| CAT-1 | implemented | n/a (pure) | `translations` again. |'], 'is already rowed'],
        ['a ranged rule cell', replaceRow(3, '| BIND-1..6 | n/a (profile: binding) | - | Profile binding. |'), 'must be exactly one rule id'],
        ['a compound rule cell', replaceRow(0, '| CAT-1 (presence) | implemented | n/a (pure) | `translations`. |'), 'must be exactly one rule id'],
        ['an off-vocabulary status', replaceRow(0, '| CAT-1 | corroborated (cross-implementation) | n/a (pure) | `translations`. |'), 'is not canonical'],
        ['provisional without "waits on:"', replaceRow(1, '| GATE-1 | provisional | mock | `grant-lane` capability. |'), 'waits on:'],
        ['implemented naming no test that exists', replaceRow(0, '| CAT-1 | implemented | n/a (pure) | `no-such-test-file` suite. |'), 'names no test that exists'],
        ['an em dash where the tier needs a hyphen', replaceRow(2, `| GATE-3 | partial | ${EM_DASH} | No test yet. |`), 'is not one of'],
        ['delegated, which is for bindings only', replaceRow(2, '| GATE-3 | delegated | - | Rests elsewhere. |'), 'bindings only'],
    ])('%s', (_label, rows, message) => {
        const r = run(['--structure-only', '--file', writeDoc(rows as string[])]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(message as string);
    });

    it('a status table without the canonical columns', () => {
        const header = HEADER.map((l) => (l.startsWith('| Rule |') ? '| Rule | Status | Evidence | Test |' : l));
        const r = run(['--structure-only', '--file', writeDoc(GOOD, header)]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('expected exactly one');
    });

    it('backticked profile words', () => {
        const header = HEADER.map((l) => (l.startsWith('| **Profiles**') ? '| **Profiles** | `all`, `browser` |' : l));
        const r = run(['--structure-only', '--file', writeDoc(GOOD, header)]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('is not one of all, browser, server, binding');
    });

    it('a revision row with no blob after the word "blob"', () => {
        const header = HEADER.map((l) =>
            l.startsWith('| **Spec revision read**') ? '| **Spec revision read** | langsys2 5cff03a1, docs/sdk-spec.mdx |' : l
        );
        const r = run(['--structure-only', '--file', writeDoc(GOOD, header)]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain('no 40-hex id after the word "blob"');
    });
});
