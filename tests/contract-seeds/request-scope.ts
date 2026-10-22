import { seedFile } from './worlds.js';

export default seedFile('scope', 10, {
    base: {
        projects: {
            p1: {
                base_locale: 'en',
                target_locales: ['de', 'it'],
                website_url: 'https://site.local',
                phrases: [
                    { category: 'UI', phrase: 'Hello', translations: { de: 'Hallo', it: 'Ciao' } },
                    { category: 'UI', phrase: 'Goodbye', translations: { de: 'Tschüss', it: 'Arrivederci' } },
                ],
            },
        },
        keys: {
            'k-write': { project: 'p1', type: 'write' },
            'k-read': { project: 'p1', type: 'read' },
        },
        count: 24,
    },
});
