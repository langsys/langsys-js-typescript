import { seedFile } from './worlds.js';

export default seedFile('content', 5, {
    // A project with nothing in it yet, one per client session a case starts.
    empty: {
        projects: { p1: { base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local' } },
        keys: { 'k-write': { project: 'p1', type: 'write' } },
        count: 14,
    },
});
