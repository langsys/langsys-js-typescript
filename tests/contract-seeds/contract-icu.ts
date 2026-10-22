import { seedFile } from './worlds.js';

/** A plural promoted to ICU on the base locale, which the catalog serves as its message only to a client that asks. */
export const PLURAL = '{count, plural, one {# file} other {# files}}';

export default seedFile('icu', 7, {
    plural: {
        count: 2,
        projects: {
            p1: {
                base_locale: 'en',
                target_locales: ['es-es'],
                website_url: 'https://site.local',
                phrases: [{ category: 'UI', phrase: '{count} files', translations: { en: PLURAL } }],
            },
        },
        keys: { 'k-read': { project: 'p1', type: 'read' } },
    },
});
