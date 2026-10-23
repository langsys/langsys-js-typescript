import { generateCustomId } from '../../src/content-block.js';
import { seedFile, type BlockSeed, type ProjectSeed, type WorldSeed } from './worlds.js';

export const OUTER = generateCustomId('UI', ['Pricing plans', 'Pick one']);
export const INNER = generateCustomId('UI', ['Inner title', 'Inner body']);

const OUTER_BLOCK: BlockSeed = {
    category: 'UI',
    custom_id: OUTER,
    content: '<p>Pricing plans</p><p>Pick one</p><section data-ls-contentblock></section>',
    phrases: [
        { phrase: 'Pricing plans', translations: { 'it-it': 'Piani tariffari', 'de-de': 'Preispläne' } },
        { phrase: 'Pick one', translations: { 'it-it': 'Scegline uno', 'de-de': 'Wähle einen' } },
    ],
};
const INNER_BLOCK: BlockSeed = {
    category: 'UI',
    custom_id: INNER,
    content: '<h2>Inner title</h2><p>Inner body</p>',
    phrases: [
        { phrase: 'Inner title', translations: { 'it-it': 'Titolo interno', 'de-de': 'Innerer Titel' } },
        { phrase: 'Inner body', translations: { 'it-it': 'Corpo interno', 'de-de': 'Innerer Text' } },
    ],
};

const world = (blocks: BlockSeed[], count: number): WorldSeed => ({
    projects: { p1: { base_locale: 'en', target_locales: ['it-it', 'de-de'], website_url: 'https://site.local', blocks } satisfies ProjectSeed },
    keys: {
        'k-write': { project: 'p1', type: 'write' },
        'k-read': { project: 'p1', type: 'read' },
    },
    count,
});

export default seedFile('served', 4, {
    // The outer block and the block nested in it, both translated.
    base: world([OUTER_BLOCK, INNER_BLOCK], 4),
    // New page content around a block already translated.
    'new outer': world([INNER_BLOCK], 2),
    // Beside both, a phrase-shaped block whose id is not its phrase's.
    'phrase-shaped block': world(
        [OUTER_BLOCK, INNER_BLOCK, { category: 'UI', custom_id: 'pricing-hero', content: '<p>Pricing plans</p>', phrases: [{ phrase: 'Pricing plans', translations: { 'it-it': 'Piani tariffari' } }] }],
        1
    ),
    'no blocks': world([], 4),
});
