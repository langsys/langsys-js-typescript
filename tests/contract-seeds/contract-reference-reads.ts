import { seedFile, type ProjectSeed, type WorldSeed } from './worlds.js';

// Every locale a session or request scope here is current in, since the API serves a catalog only
// at a project's own locales.
const P: ProjectSeed = { base_locale: 'en-us', target_locales: ['fr-fr', 'es-es', 'de-de', 'he-il', 'en-us-posix'] };

const world = (format: ProjectSeed['locale_code_format'], count: number, second = false): WorldSeed => ({
    projects: { p1: { ...P, locale_code_format: format }, ...(second ? { p2: P } : {}) },
    keys: {
        k1: { project: 'p1', type: 'read' },
        // A key whose second identical request inside the minute is refused 429.
        'k-once': { project: 'p1', type: 'read', duplicate_guard: { max_attempts: 1, window_seconds: 60 } },
        ...(second ? { k2: { project: 'p2', type: 'read' } as const } : {}),
    },
    unknown: { keys: ['k-unknown'] },
    count,
});

export default seedFile('reference', 8, {
    lists: world('lowercase-hyphen', 200),
    // A second project with a key of its own.
    'two projects': world('lowercase-hyphen', 12, true),
    posix: world('posix', 3),
    bcp47: world('bcp47', 6),
});
