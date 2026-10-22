import { seedFile } from './worlds.js';

export default seedFile('headers', 9, {
    base: {
        projects: { p1: { base_locale: 'en', target_locales: ['es-es', 'de-de'], website_url: 'https://site.local' } },
        keys: { 'k-read': { project: 'p1', type: 'read' } },
        count: 2,
    },
});
