import { seedFile, type KeySeed, type ProjectSeed, type WorldSeed } from './worlds.js';

/** The write-grant secret `k-grant` verifies grants with: php-jwt's HS256 needs at least 32 bytes. */
export const GRANT_SECRET = 'grant-secret-of-at-least-32-bytes';

const P1: ProjectSeed = {
    base_locale: 'en-us',
    target_locales: ['es-es'],
    website_url: 'https://www.site.local',
    phrases: [{ category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } }],
};
const P2: ProjectSeed = { target_locales: ['fr-fr'], website_url: 'https://other.local' };

const KEYS: Record<string, KeySeed> = {
    'k-write': { project: 'p1', type: 'write' },
    'k-read': { project: 'p1', type: 'read', report_discovered_content: true },
    // The canonical public site: read-only here, permitted to report.
    'k-public': { project: 'p1', type: 'ip_write', report_discovered_content: true },
    'k-ipw-local': { project: 'p1', type: 'ip_write', ip_allowlist: ['@net'] },
    // May report AND may write from its case's own address: the only reason to decline its hint
    // is that the caller can write, which is what isolates that check (GATE-6's server side).
    'k-writer-reporter': { project: 'p1', type: 'ip_write', ip_allowlist: ['@self'], report_discovered_content: true },
    'k-grant': { project: 'p1', type: 'read', write_grant_secret: GRANT_SECRET },
    'k-dup': { project: 'p1', type: 'read', duplicate_guard: { max_attempts: 1, window_seconds: 60 } },
    'k-guarded': { project: 'p1', type: 'read', duplicate_guard: { max_attempts: 3, window_seconds: 10 } },
    'k-other': { project: 'p2', type: 'write' },
    'k-orphan': { project: null, type: 'write' },
};

/** The API's world: two projects and a key for every way a key can be. */
const world = (p1: ProjectSeed = {}, count = 1): WorldSeed => ({
    projects: { p1: { ...P1, ...p1 }, p2: P2 },
    keys: KEYS,
    unknown: { keys: ['nope'], projects: ['p-unknown'] },
    count,
});

const quota = (used: number, count: number) => world({ target_locales: ['es-es', 'fr-fr'], human_translation_word_limit: 3, human_translation_words_used: used }, count);

export default seedFile('api', 1, {
    base: world({}, 83),
    // A project accepts a hint only while it machine-translates new content.
    hint: world({ machine_translate_new_phrases: true }, 7),
    'hint no credits': world({ machine_translate_new_phrases: true, credits_exhausted: true }),
    suspended: world({ subscription_suspended: true }, 2),
    'base locale only': world({ discovery_base_locale_only: true }),
    'stored icu': world({
        phrases: [
            { category: 'UI', phrase: '{count} files', translations: { 'en-us': '{count, plural, one {# file} other {# files}}' } },
            { category: 'UI', phrase: '{gender} replied', translations: { 'en-us': '{gender, select, female {She replied} other {They replied}}' } },
            { category: 'UI', phrase: 'Welcome', translations: { 'en-us': 'Hi there' } },
        ],
    }),
    'seeded flags': world({
        phrases: [{ category: 'UI', phrase: 'acme.com' }, { category: 'UI', phrase: 'Acme', translatable: false }, { category: 'UI', phrase: 'Plain' }],
        blocks: [{ category: 'Home', custom_id: 'b1', content: '<p>Shown</p><p>Kept</p>', phrases: [{ phrase: 'Shown' }, { phrase: 'Kept', translatable: false }] }],
    }),
    // API usage is metered per organization, and each project is an organization of its own,
    // so a key whose balance is spent has a project of its own.
    broke: { projects: { p1: P1 }, keys: { 'k-broke': { project: 'p1', type: 'write', usage_exhausted: true } }, count: 2 },
    'quota unspent': quota(0, 2),
    'quota spent': quota(3, 1),
    'quota one word left': quota(2, 1),
});
