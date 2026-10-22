import { seedFile, type KeySeed, type ProjectSeed, type WorldSeed } from './worlds.js';

const P1: ProjectSeed = {
    base_locale: 'en',
    target_locales: ['es-es'],
    website_url: 'https://site.local',
    phrases: [{ category: 'UI', phrase: 'Known', translations: { 'es-es': 'Conocido' } }],
};

const world = (p1: ProjectSeed, ipw: KeySeed, count: number): WorldSeed => ({
    projects: { p1: { ...P1, ...p1 } },
    keys: {
        'k-write': { project: 'p1', type: 'write' },
        'k-read': { project: 'p1', type: 'read' },
        'k-ipw': ipw,
    },
    count,
});

export default seedFile('write', 2, {
    // k-ipw may write from the case's own address.
    base: world({}, { project: 'p1', type: 'ip_write', ip_allowlist: ['@self'] }, 33),
    // k-ipw may write only from the case's second address, so a session from its first is read-only.
    'ipw elsewhere': world({}, { project: 'p1', type: 'ip_write', ip_allowlist: ['@moved'] }, 2),
    gated: world({ discovery_base_locale_only: true }, { project: 'p1', type: 'ip_write', ip_allowlist: ['@self'] }, 4),
    // A second project with a write key of its own, which the app re-initialises under.
    'two projects': {
        projects: { p1: P1, p2: P1 },
        keys: { 'k-write': { project: 'p1', type: 'write' }, 'k-write-2': { project: 'p2', type: 'write' } },
        count: 3,
    },
});
