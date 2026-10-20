import { defineConfig } from 'vitest/config';

// Against an SDK test clone (LANGSYS_CONTRACT_TARGET), every request is a real one and the clock
// waits in real time: a case that advances it a minute takes that minute.
const againstClone = Boolean(process.env.LANGSYS_CONTRACT_TARGET);

export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        ...(againstClone ? { testTimeout: 200_000, hookTimeout: 60_000 } : {}),
    },
});
