import { configDefaults, defineConfig } from 'vitest/config';

// Against an SDK test clone (LANGSYS_CONTRACT_TARGET), every request is a real one and the clock
// waits in real time: a case that advances it a minute takes that minute.
const againstClone = Boolean(process.env.LANGSYS_CONTRACT_TARGET);

// The files that run against an SDK test clone (spec CONF-2, contract-fixture/README.md) and throw
// without one, since a contract test never passes by skipping. `npm test` runs them with the rest.
// GitHub's CI has no clone, so it runs the `no-clone` project alone (`npm run test:no-clone`).
// `contract-forwarder` and `contract-reference-lists` start the fixture against a stand-in clone of
// their own, so they need none and are not listed.
const CLONE_TIER = [
    'tests/contract-api.test.ts',
    'tests/contract-block-content.test.ts',
    'tests/contract-hint-lane.test.ts',
    'tests/contract-icu.test.ts',
    'tests/contract-phrase-exclusion.test.ts',
    'tests/contract-reference-reads.test.ts',
    'tests/contract-served-block.test.ts',
    'tests/contract-write-lane.test.ts',
    'tests/locale-headers.test.ts',
    'tests/request-scope.test.ts',
    'tests/request-scope-credentials.test.ts',
];

export default defineConfig({
    test: {
        environment: 'node',
        ...(againstClone ? { testTimeout: 200_000, hookTimeout: 60_000 } : {}),
        projects: [
            { extends: true, test: { name: 'no-clone', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, ...CLONE_TIER] } },
            { extends: true, test: { name: 'clone', include: CLONE_TIER } },
        ],
    },
});
