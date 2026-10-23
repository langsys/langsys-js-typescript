import { seedFile, type ProjectSeed } from './worlds.js';

/** The write-grant secret `key-two-granted` verifies grants with: php-jwt's HS256 needs at least 32 bytes. */
export const GRANT_SECRET = 'grant-secret-of-at-least-32-bytes';

/** A tenant whose catalog names it, so a render shows which project it read. */
const tenant = (name: string): ProjectSeed => ({
    base_locale: 'en',
    target_locales: ['de', 'it'],
    website_url: `https://${name}.local`,
    phrases: [{ category: 'UI', phrase: 'Hello', translations: { de: `Hallo ${name}`, it: `Ciao ${name}` } }],
});

export default seedFile('credentials', 11, {
    // Three tenants of one server process: `zero` is the process's own.
    tenants: {
        projects: { zero: tenant('zero'), one: tenant('one'), two: tenant('two') },
        keys: {
            'key-zero': { project: 'zero', type: 'write' },
            'key-zero-read': { project: 'zero', type: 'read' },
            'key-one': { project: 'one', type: 'write' },
            'key-two': { project: 'two', type: 'write' },
            'key-two-read': { project: 'two', type: 'read' },
            'key-two-granted': { project: 'two', type: 'read', write_grant_secret: GRANT_SECRET },
        },
        count: 25,
    },
});
