import { generateCustomId } from '../../src/content-block.js';
import canonicalization from '../fixtures/canonicalization-reference.json';
import { seedFile, type BlockSeed, type PhraseSeed, type WorldSeed } from './worlds.js';

const ROWS = (canonicalization as unknown as { phrase_cases: { id: string; expected_phrase: string; earlier_phrase?: string }[] }).phrase_cases;
const EARLIER_ROW = ROWS.find((r) => r.id === 'tok1-rich-earlier-key')!;

/** The earlier key of the fixture's moved row, translated. */
const EARLIER: PhraseSeed = { phrase: EARLIER_ROW.earlier_phrase!, category: 'UI', translations: { 'es-es': 'Bienvenido a {m0o}Langsys{m0c}, {m1o}amigo{m1c}' } };
/** The key of a caller's param inside an author's exclusion, translated. */
const EXCLUDED_PARAM: PhraseSeed = { phrase: 'Write to {m0o}{m0c} for help', category: 'UI', translations: { 'es-es': 'Escribe a {m0o}{m0c} para ayuda' } };
const BLOCK_TOKENS = ['Use', 'in templates', 'Write it as shown'];
const BLOCK_WITH_CODE: BlockSeed = {
    category: 'UI',
    custom_id: generateCustomId('UI', BLOCK_TOKENS),
    content: '<p>Use <code translate="no">{name}</code> in templates</p><p>Write it as shown</p>',
    phrases: [
        { phrase: 'Use', translations: { 'es-es': 'Usa' } },
        { phrase: 'in templates', translations: { 'es-es': 'en plantillas' } },
        { phrase: 'Write it as shown', translations: { 'es-es': 'Escríbelo como se muestra' } },
    ],
};

const world = (count: number, phrases: PhraseSeed[] = [], blocks: BlockSeed[] = []): WorldSeed => ({
    projects: { p1: { base_locale: 'en', target_locales: ['es-es'], website_url: 'https://site.local', phrases, blocks } },
    keys: { 'k-write': { project: 'p1', type: 'write' } },
    count,
});

export default seedFile('exclusion', 6, {
    empty: world(33),
    'signed in': world(1, [{ phrase: 'Signed in as {m0o}{m0c} today', category: 'UI', translations: { 'es-es': 'Conectado como {m0o}{m0c} hoy' } }]),
    // A translation that puts a word inside the opaque pair.
    'signed in, word inside': world(2, [{ phrase: 'Signed in as {m0o}{m0c} today', category: 'UI', translations: { 'es-es': 'Conectado como {m0o}correo{m0c} hoy' } }]),
    'nested opaque': world(1, [{ phrase: '{m0o}{m0c} and {m1o}y{m1c}', category: 'UI', translations: { 'es-es': '{m0o}{m0c} e {m1o}y{m1c}' } }]),
    'earlier key': world(2, [EARLIER]),
    'earlier and current': world(1, [EARLIER, { phrase: EARLIER_ROW.expected_phrase, category: 'UI', translations: { 'es-es': 'Hola, {m0o}{m0c}, {m1o}amigo{m1c}' } }]),
    'excluded param': world(2, [EXCLUDED_PARAM]),
    'block with code': world(2, [], [BLOCK_WITH_CODE]),
});
