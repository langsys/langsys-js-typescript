import { seedFile, type ProjectSeed, type WorldSeed } from './worlds.js';

// A project accepts a hint only while it machine-translates new content.
const P1: ProjectSeed = { base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local', machine_translate_new_phrases: true };

const world = (p1: ProjectSeed, count: number, extra: Pick<WorldSeed, 'projects' | 'keys'> = { projects: {}, keys: {} }): WorldSeed => ({
    projects: { p1: { ...P1, ...p1 }, ...extra.projects },
    keys: {
        // Read-only from the case's address, and permitted to report: the canonical public site.
        'k-public': { project: 'p1', type: 'ip_write', report_discovered_content: true },
        // Read-only from the case's address, and NOT permitted to report.
        'k-private': { project: 'p1', type: 'ip_write', report_discovered_content: false },
        // May write from the case's own address, and permitted to report.
        'k-writer': { project: 'p1', type: 'ip_write', ip_allowlist: ['@self'], report_discovered_content: true },
        ...extra.keys,
    },
    count,
});

export default seedFile('hint', 3, {
    base: world({}, 14),
    gated: world({ discovery_base_locale_only: true }, 1),
    // A second project the page's server renders a request for, under a key of its own.
    'two projects': world({}, 1, {
        projects: { other: P1 },
        keys: { 'k-other': { project: 'other', type: 'ip_write', report_discovered_content: true } },
    }),
});
