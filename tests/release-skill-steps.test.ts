import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `_dev_/publish.sh`'s steps for the agent skill, run from the script's own text.
 *
 * - **The slot check** passes a clean skill and refuses one still holding a template `{{SLOT}}`.
 *   It runs under the script's ERR trap, as a release runs it. On a clean skill its grep finds
 *   nothing and exits 1, and an assignment whose command substitution fails trips that trap, so
 *   a check that doesn't absorb the status aborts every release with "Unexpected error occurred".
 * - **The skill gate** runs after the release build and before the commit is amended, so the
 *   skill is held to the build it ships with before anything is pushed or tagged.
 */

const SCRIPT = readFileSync(join(__dirname, '..', '_dev_', 'publish.sh'), 'utf8');

/** The script's ERR trap line, and its slot check from the assignment to the closing `fi`. */
const TRAP = SCRIPT.match(/^trap '[^\n]*' ERR$/m)?.[0];
const SLOT_CHECK = SCRIPT.match(/^SKILL_SLOTS=\$\([^\n]*\n[\s\S]*?^fi$/m)?.[0];

let dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

/** Runs the slot check in a folder whose skill/ holds `files`, with a handle_error that reports and exits 3. */
function runSlotCheck(files: Record<string, string>): { status: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'release-skill-steps-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'skill'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 'skill', name), text);
    const script = ['handle_error() { echo "HANDLED: $1"; exit 3; }', TRAP, SLOT_CHECK, 'echo PASSED'].join('\n');
    try {
        return { status: 0, out: execFileSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8' }) };
    } catch (error) {
        const e = error as { status: number; stdout: string };
        return { status: e.status, out: e.stdout };
    }
}

describe("publish.sh's agent-skill steps", () => {
    it('reads its trap and its slot check from the script', () => {
        expect(TRAP).toContain('handle_error');
        expect(SLOT_CHECK).toMatch(/^SKILL_SLOTS=\$\(grep [\s\S]*handle_error [\s\S]*\nfi$/);
    });

    it('passes a clean skill under the ERR trap', () => {
        const run = runSlotCheck({ 'SKILL.md': '# Langsys TypeScript core\n\nNo template slots here.\n' });
        expect(run.out).not.toContain('HANDLED');
        expect(run).toEqual({ status: 0, out: 'PASSED\n' });
    });

    it('refuses a skill that still holds a template slot, naming it', () => {
        const run = runSlotCheck({ 'SKILL.md': '# Title\n', 'preamble.md': 'Install it with {{INSTALL_COMMAND}}.\n' });
        expect(run.status).toBe(3);
        expect(run.out).toContain('HANDLED: skill/ still holds an unfilled template slot');
        expect(run.out).toContain('{{INSTALL_COMMAND}}');
    });

    it('runs the skill gate after the release build and before the commit is amended', () => {
        const build = SCRIPT.search(/^npm run build$/m);
        const gate = SCRIPT.search(/^npx vitest run tests\/skill-gate\.test\.ts \|\| handle_error /m);
        const amend = SCRIPT.indexOf('git commit --amend');
        expect(build).toBeGreaterThan(-1);
        expect(gate, 'the skill gate, failing into handle_error').toBeGreaterThan(build);
        expect(amend).toBeGreaterThan(gate);
    });
});
