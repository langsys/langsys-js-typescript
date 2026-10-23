#!/usr/bin/env node
/**
 * Check CONFORMANCE.md against the canonical conformance format, and against the spec
 * blob it cites, then report the grade tally.
 *
 * WHY THIS EXISTS. The operator's definition of GREEN for the 8.0.1 push requires
 * every rule id accounted for exactly once, counted by a script that exits non-zero on
 * a missing or duplicated id, and every row graded from a fixed vocabulary. Counting
 * by hand is how this file carried twelve rows graded `implemented` with a recorded
 * tier of `mock` through several review rounds, a contradiction sitting in plain view.
 * So this checks STATUS AGAINST TIER, not status alone.
 *
 * CANONICAL FORMAT (Reviewer, 2026-09-12, the same shape a reviewer-side checker
 * measures across every SDK):
 *   - header row  | **Spec revision read** | langsys2 <commit>…, docs/sdk-spec.mdx blob <40-hex> |
 *   - header row  | **Profiles** | all, browser |          words from: all, browser, server, binding
 *   - ONE status table whose header begins  | Rule | Status | Tier | Evidence |
 *   - ONE rule id per row, every id in the spec, no ranges, family rows or compound ids
 *   - status: implemented | provisional | delegated | partial | not implemented |
 *             held (strip ruling) | waived | n/a (profile: <p>) | n/a (architecture: <reason>)
 *   - tier:   live | contract | mock | n/a (pure) | -
 *             implemented needs live, contract or n/a (pure); provisional needs mock
 *
 * TIER RULE (fleet-wide correction): the tier describes the evidence for the property
 * the rule governs, not whether a test double appears. live, contract and mock apply
 * only where that property depends on what the API answers. In-process behaviour,
 * cross-implementation identity fixtures, meta-rules discharged by the document and
 * its checker, artifact inspection with a positive control, and isolation or scoping
 * properties are `n/a (pure)`. A script cannot judge that distinction; it checks only
 * that the declared tier is one the declared status may carry.
 *
 * Usage:
 *   node _dev_/tally-conformance.mjs                    full check against ~/Documents/dev/langsys2
 *   node _dev_/tally-conformance.mjs /path/to/langsys2  full check against another spec checkout
 *   node _dev_/tally-conformance.mjs --structure-only   no spec needed
 *   node _dev_/tally-conformance.mjs --file other.md    check another file (the test's controls use this)
 *
 * Exit, full check:        0 green | 1 structural error | 2 cannot check | 3 valid but NOT green
 * Exit, --structure-only:  0 structurally valid | 1 structural error | 2 cannot check
 * Greenness is always REPORTED. Under --structure-only it does not decide the exit: a
 * sound file full of honest `provisional` rows is correct, and CI must not fail for
 * telling the truth.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const structureOnly = argv.includes('--structure-only');
const fileAt = argv.indexOf('--file');
const FILE = fileAt >= 0 ? argv[fileAt + 1] : join(ROOT, 'CONFORMANCE.md');
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--file');
const SPEC_REPO = positional[0] ?? join(homedir(), 'Documents', 'dev', 'langsys2');
const SPEC_PATH = 'docs/sdk-spec.mdx';
const TESTS_DIR = join(ROOT, 'tests');

const PROFILE_WORDS = ['all', 'browser', 'server', 'binding'];
const TIERS = ['live', 'contract', 'mock', 'n/a (pure)', '-'];

function cannotCheck(message) {
    console.error(`CANNOT CHECK: ${message}`);
    process.exit(2);
}

if (!FILE || !existsSync(FILE)) cannotCheck(`no conformance file at ${FILE}`);
const lines = readFileSync(FILE, 'utf8').split('\n');
const splitRow = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
const errors = [];

// ---------------------------------------------------------------- header rows
const revisionLine = lines.find((l) => /^\|\s*\*\*Spec revision read\*\*\s*\|/.test(l));
const revisionCell = revisionLine ? splitRow(revisionLine)[1] ?? '' : '';
const citedBlob = revisionCell.match(/\bblob\s+([0-9a-f]{40})\b/)?.[1];
const citedCommit = revisionCell.match(/\blangsys2\s+([0-9a-f]{7,40})/)?.[1];
if (!revisionLine) errors.push('HEADER  no "| **Spec revision read** |" row');
else if (!citedBlob) errors.push('HEADER  "Spec revision read" has no 40-hex id after the word "blob"');
else if (!citedCommit) errors.push('HEADER  "Spec revision read" names no "langsys2 <commit>"');

const profilesLine = lines.find((l) => /^\|\s*\*\*Profiles\*\*\s*\|/.test(l));
const sdkProfiles = profilesLine
    ? (splitRow(profilesLine)[1] ?? '').split(',').map((w) => w.trim()).filter(Boolean)
    : [];
if (!profilesLine) errors.push('HEADER  no "| **Profiles** |" row');
for (const w of sdkProfiles) {
    if (!PROFILE_WORDS.includes(w)) errors.push(`HEADER  profile "${w}" is not one of ${PROFILE_WORDS.join(', ')}`);
}

// ---------------------------------------------------------------- the one status table
const tableStarts = lines
    .map((l, i) => (/^\|\s*Rule\s*\|\s*Status\s*\|\s*Tier\s*\|\s*Evidence\s*\|/.test(l) ? i : -1))
    .filter((i) => i >= 0);
if (tableStarts.length !== 1) {
    errors.push(`TABLE  expected exactly one "| Rule | Status | Tier | Evidence |" table, found ${tableStarts.length}`);
}
const stray = lines
    .map((l, i) => (/^\|\s*Rule\s*\|\s*Status\s*\|/.test(l) && !tableStarts.includes(i) ? i + 1 : 0))
    .filter(Boolean);
for (const n of stray) errors.push(`TABLE  :${n} is a second "| Rule | Status |" table without the canonical columns`);

const rows = [];
if (tableStarts.length === 1) {
    const at = tableStarts[0];
    const width = splitRow(lines[at]).length;
    for (let j = at + 2; j < lines.length && lines[j].startsWith('|'); j++) {
        const c = splitRow(lines[j]);
        rows.push({ line: j + 1, id: c[0] ?? '', status: c[1] ?? '', tier: c[2] ?? '', evidence: c.slice(3).join(' | '), cells: c.length, width });
    }
}
const err = (row, message) => errors.push(`:${row.line}  ${String(row.id).slice(0, 24)}  ${message}`);

// ---------------------------------------------------------------- one id per row
const seen = new Map();
for (const row of rows) {
    if (row.cells !== row.width) err(row, `has ${row.cells} cells under a ${row.width}-column header`);
    if (!/^[A-Z]{2,5}-\d+$/.test(row.id)) {
        err(row, 'the Rule cell must be exactly one rule id; no ranges, families, lists, wildcards or descriptive suffixes');
        continue;
    }
    if (seen.has(row.id)) err(row, `${row.id} is already rowed at :${seen.get(row.id)}`);
    else seen.set(row.id, row.line);
}

// ---------------------------------------------------------------- vocabulary, and status against tier
const testsOnDisk = new Set(
    existsSync(TESTS_DIR) ? readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.ts')).map((f) => f.slice(0, -8)) : []
);
const namesATest = (text) => [...text.matchAll(/`([a-z0-9-]+)`/g)].some((m) => testsOnDisk.has(m[1]));

function classify(status) {
    let m;
    if (status === 'implemented') return { key: status, green: true, tiers: ['live', 'contract', 'n/a (pure)'], needsTest: true };
    if (status === 'provisional') return { key: status, green: false, tiers: ['mock'], needsTest: true, waitsOn: true };
    if (status === 'partial') return { key: status, green: false, tiers: ['-'] };
    if (status === 'not implemented') return { key: status, green: false, tiers: ['-'] };
    if (status === 'held (strip ruling)') return { key: status, green: false, tiers: TIERS };
    if (status === 'delegated') return { key: status, green: true, tiers: ['-'], bindingOnly: true };
    if (status === 'waived') return { key: status, green: false, tiers: ['-'], needsAgreement: true };
    if ((m = status.match(/^n\/a \(profile: (.+)\)$/))) return { key: 'n/a (profile)', green: true, tiers: ['-'], profileClaim: m[1] };
    if ((m = status.match(/^n\/a \(architecture: (.{12,})\)$/))) return { key: 'n/a (architecture)', green: true, tiers: ['-'] };
    return null;
}

for (const row of rows) {
    const g = classify(row.status);
    row.grade = g;
    if (!g) {
        err(row, `status "${row.status}" is not canonical (implemented | provisional | delegated | partial | ` +
            'not implemented | held (strip ruling) | waived | n/a (profile: <p>) | n/a (architecture: <reason>))');
        continue;
    }
    if (!TIERS.includes(row.tier)) err(row, `tier "${row.tier}" is not one of: ${TIERS.join(' | ')}`);
    else if (!g.tiers.includes(row.tier)) {
        const why = g.key === 'implemented' && row.tier === 'mock' ? ' (mock evidence makes the row provisional, CONF-2)' : '';
        err(row, `status "${g.key}" cannot carry tier "${row.tier}"${why}`);
    }
    if (g.needsTest && !namesATest(row.evidence)) err(row, `"${g.key}" names no test that exists in tests/`);
    if (g.waitsOn && !/waits on:/i.test(row.evidence)) err(row, 'provisional must name what it "waits on:"');
    if (g.bindingOnly && !sdkProfiles.includes('binding')) err(row, 'delegated is for bindings only, and this SDK does not claim the binding profile');
    if (g.needsAgreement && !(/operator/i.test(row.evidence) && /agree/i.test(row.evidence))) {
        err(row, 'waived needs the operator\'s recorded agreement in the evidence');
    }
}

// ---------------------------------------------------------------- the spec
let spec = null;
if (!structureOnly && citedBlob && citedCommit) {
    if (!existsSync(join(SPEC_REPO, '.git'))) cannotCheck(`no spec checkout at ${SPEC_REPO} (pass it, or use --structure-only)`);
    const git = (...a) => execFileSync('git', ['-C', SPEC_REPO, ...a], { encoding: 'utf8' });
    let carried;
    try {
        carried = git('ls-tree', citedCommit, SPEC_PATH).split(/\s+/)[2];
    } catch {
        cannotCheck(`commit ${citedCommit} is not in ${SPEC_REPO}`);
    }
    if (carried !== citedBlob) {
        errors.push(`HEADER  cites blob ${citedBlob}, but ${citedCommit} carries ${carried}. Run npm run verify:spec.`);
    } else {
        const body = git('cat-file', '-p', citedBlob);
        const anchors = [...body.matchAll(/<a id="([a-z]+-\d+)"><\/a>/g)];
        const profiles = new Map();
        anchors.forEach((a, i) => {
            const end = i + 1 < anchors.length ? anchors[i + 1].index : body.length;
            profiles.set(a[1].toUpperCase(), (body.slice(a.index, end).match(/\*\*Profiles:\*\*\s*(.+)/)?.[1] ?? '').trim());
        });
        const words = (p) => new Set(p.replace(/\*\*/g, '').toLowerCase().match(/[a-z]+/g) ?? []);
        const binds = (p) => sdkProfiles.some((w) => words(p).has(w));
        spec = { profiles, binds };

        for (const id of profiles.keys()) if (!seen.has(id)) errors.push(`MISSING  ${id} has no row (Profiles: ${profiles.get(id)})`);
        for (const [id, line] of seen) if (!profiles.has(id)) errors.push(`:${line}  ${id} is not a rule in blob ${citedBlob}`);
        for (const row of rows) {
            if (row.grade?.key === 'n/a (profile)' && profiles.has(row.id) && binds(profiles.get(row.id))) {
                err(row, `n/a (profile) but its Profiles line binds a profile this SDK claims: ${profiles.get(row.id)}`);
            }
        }
    }
}

// ---------------------------------------------------------------- report
const count = (pick) => rows.reduce((m, r) => (m.set(pick(r), (m.get(pick(r)) ?? 0) + 1), m), new Map());
const byStatus = count((r) => r.grade?.key ?? `INVALID: ${r.status}`);
const implementedTier = count((r) => (r.grade?.key === 'implemented' ? r.tier : null));
implementedTier.delete(null);
const waits = count((r) => (r.grade?.key === 'provisional' ? (r.evidence.match(/waits on:\s*([^;.|]+)/i)?.[1] ?? '?').trim() : null));
waits.delete(null);
const notGreen = rows.filter((r) => !r.grade?.green);

console.log(`file   : ${FILE.startsWith(ROOT) ? FILE.slice(ROOT.length + 1) : FILE}`);
console.log(`cites  : langsys2 ${citedCommit ?? '?'}, blob ${citedBlob ?? '?'}`);
console.log(spec ? `spec   : ${spec.profiles.size} rule ids in the cited blob` : 'spec   : not consulted (--structure-only, or no readable citation)');
console.log(`profile: ${sdkProfiles.join(', ') || '?'}`);
if (spec) {
    const bound = [...spec.profiles.values()].filter((p) => spec.binds(p)).length;
    console.log(`binds  : ${bound} of ${spec.profiles.size} rules name a profile this SDK claims`);
}
console.log(`rows   : ${rows.length} in the status table, ${seen.size} distinct rule ids`);
console.log('\ntally:');
for (const [k, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padEnd(4)}${k}`);
if (implementedTier.size) {
    console.log('  implemented, by tier:');
    for (const [t, n] of implementedTier) console.log(`    ${String(n).padEnd(4)}${t}`);
}
if (waits.size) {
    console.log('  provisional, by what it waits on:');
    for (const [w, n] of waits) console.log(`    ${String(n).padEnd(4)}${w}`);
}
if (notGreen.length) {
    console.log(`\nnot green (${notGreen.length}):`);
    for (const r of notGreen) console.log(`  :${String(r.line).padEnd(5)}${String(r.id).padEnd(10)}${r.grade?.key ?? r.status}`);
}
if (errors.length) {
    console.log(`\nSTRUCTURAL ERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  ${e}`);
}
const green = !errors.length && !notGreen.length;
console.log(`\nverdict: ${errors.length ? `STRUCTURAL ERRORS (${errors.length})` : green ? 'GREEN' : `NOT GREEN (${notGreen.length} rows)`}`);
if (errors.length) process.exit(1);
if (structureOnly) process.exit(0);
process.exit(green ? 0 : 3);
