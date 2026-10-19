import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startContractFixture, type ContractFixture } from './helpers/contract-fixture.js';

/**
 * The contract double's own tests (spec CONF-2). Every other lane grades API-dependent rows
 * against this double, so what it enforces is pinned here: that it can say no, that it holds
 * state, that it computes the write decision rather than being told it, that hints follow the
 * backend's acceptance rules, and that it offers no request log.
 *
 * Each "says no" case is paired with the same request succeeding under the condition that
 * permits it, so a double that refused everything would fail as surely as one that accepted
 * everything.
 */

let fx: ContractFixture;

const BASE_SEED = {
    config: { renderer_egress_ips: ['10.9.9.9'], batch_limit: 3, hint_rate_per_minute: 50 },
    projects: [
        {
            id: 'p1',
            base_locale: 'en-us',
            target_locales: ['es-es'],
            website_url: 'https://www.site.local',
            phrases: [{ category: 'UI', phrase: 'Hello', translations: { 'es-es': 'Hola' } }],
        },
        { id: 'p2', target_locales: ['fr-fr'], website_url: 'https://other.local' },
    ],
    keys: [
        { key: 'k-write', project: 'p1', type: 'write' },
        { key: 'k-read', project: 'p1', type: 'read', report_discovered_content: true },
        // The canonical public site: read-only here, permitted to report.
        { key: 'k-public', project: 'p1', type: 'ip_write', report_discovered_content: true },
        { key: 'k-ipw-local', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.0/8'] },
        // May report AND may write from here: the only reason to decline its hint is that
        // the caller can write, which is what isolates that check (GATE-6's server side).
        { key: 'k-writer-reporter', project: 'p1', type: 'ip_write', ip_allowlist: ['127.0.0.1'], report_discovered_content: true },
        { key: 'k-grant', project: 'p1', type: 'read', write_grant_secret: 'grant-secret' },
        { key: 'k-other', project: 'p2', type: 'write' },
        { key: 'k-orphan', project: null, type: 'write' },
    ],
};

type Call = { key?: string; grant?: string; method?: string; body?: unknown };
async function api(path: string, call: Call = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (call.key) headers['x-authorization'] = call.key;
    if (call.grant) headers['x-write-grant'] = call.grant;
    const res = await fetch(fx.baseUrl + path, {
        method: call.method ?? (call.body === undefined ? 'GET' : 'POST'),
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const catalog = (key: string, project = 'p1', locale = 'es-es') =>
    api(`/translations?project_id=${project}&locale=${locale}`, { key });
const register = (key: string, items: unknown[], project = 'p1') =>
    api('/translatable-items', { key, body: { project_id: project, translatable_items: items } });
const phrase = (text: string, category: string | null = 'UI') => ({ type: 'phrase', phrase: text, category });
const hint = (key: string | undefined, url: string) => api('/discovery/hint', { key, body: { page_url: url } });

function signGrant(secret: string, claims: Record<string, unknown>): string {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = part({ alg: 'HS256', typ: 'JWT' });
    const body = part(claims);
    const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
    fx = await startContractFixture();
});
afterAll(async () => {
    await fx.stop();
});
beforeEach(async () => {
    await fx.seed(BASE_SEED);
});

describe('it starts the way the README says', () => {
    it('reports an /api base URL on 127.0.0.1', () => {
        expect(fx.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api$/);
    });
});

describe('it can say no, and says yes under the condition that permits it', () => {
    it('no key is 401; an unknown key, or one with no project, is 403; a real key reads', async () => {
        expect((await catalog('')).status).toBe(401);
        expect((await catalog('nope')).status).toBe(403);
        expect((await catalog('k-orphan')).status).toBe(403);
        expect((await catalog('k-read')).status).toBe(200);
    });

    it('a suspended subscription is 402 for a write key and 403 for any other; an exhausted usage balance is 402', async () => {
        await fx.seed({ ...BASE_SEED, projects: [{ ...BASE_SEED.projects[0], subscription_suspended: true }, BASE_SEED.projects[1]] });
        expect((await catalog('k-write')).status).toBe(402);
        expect((await catalog('k-read')).status).toBe(403);
        await fx.seed({ ...BASE_SEED, keys: [{ key: 'k-broke', project: 'p1', type: 'write', usage_exhausted: true }] });
        expect((await catalog('k-broke')).status).toBe(402);
    });

    it('a session that may not write is refused with 403, and a write key is accepted', async () => {
        expect((await register('k-read', [phrase('New')])).status).toBe(403);
        expect((await register('k-write', [phrase('New')])).status).toBe(200);
    });

    it('authorization runs before the batch check: read-only and over-limit is 403, not 422', async () => {
        const over = [phrase('a'), phrase('b'), phrase('c'), phrase('d')];
        expect((await register('k-read', over)).status).toBe(403);
        expect((await register('k-write', over)).status).toBe(422);
        expect((await register('k-write', over.slice(0, 3))).status).toBe(200);
    });

    it('a key used against another project is 403 on every route, and an unknown project is 404', async () => {
        expect((await api('/authorize-project/p1', { key: 'k-other' })).status).toBe(403);
        expect((await catalog('k-other', 'p1')).status).toBe(403);
        expect((await register('k-other', [phrase('x')], 'p1')).status).toBe(403);
        expect((await api('/authorize-project/p1', { key: 'k-read' })).status).toBe(200);
        expect((await api('/authorize-project/nope', { key: 'k-read' })).status).toBe(404);
    });

    it('advertises the batch limit it enforces', async () => {
        const auth = await api('/authorize-project/p1', { key: 'k-read' });
        expect(auth.body.data.langsys_settings.translatable_items.batch_limit).toBe(3);
    });
});

describe('it holds state: a second read observes the first write', () => {
    it('a registered phrase reads back as present with a null translation', async () => {
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola' });
        await register('k-write', [phrase('Brand new')]);
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola', 'Brand new': null });
    });

    it('a refused write leaves nothing behind', async () => {
        await register('k-read', [phrase('Refused')]);
        expect((await catalog('k-read')).body.data.UI).not.toHaveProperty('Refused');
    });

    it('registration is idempotent', async () => {
        await register('k-write', [phrase('Once')]);
        await register('k-write', [phrase('Once')]);
        const ui = (await fx.state()).projects.p1.phrases.filter((p) => p.phrase === 'Once');
        expect(ui).toHaveLength(1);
    });

    it('input is cleaned as the backend cleans it: trimmed, with empty strings as null', async () => {
        await register('k-write', [phrase('  Padded  '), phrase('No category', '')]);
        const data = (await catalog('k-read')).body.data;
        expect(data.UI).toHaveProperty('Padded');
        expect(data.__uncategorized__).toEqual({ 'No category': null });
    });

    it('skips, never rejects: an empty phrase and the reserved category are dropped with a 200', async () => {
        const res = await register('k-write', [phrase(''), phrase('Reserved', '__uncategorized__'), phrase('Kept')]);
        expect(res.status).toBe(200);
        const all = (await fx.state()).projects.p1.phrases.map((p) => p.phrase);
        expect(all).toContain('Kept');
        expect(all).not.toContain('Reserved');
    });

    it('a categorised block reads back as an object whose phrases are null', async () => {
        await register('k-write', [{ type: 'content_block', custom_id: 'b1', category: 'Home', content: '<p>A</p>', phrases: [{ phrase: 'A' }, { phrase: 'B' }] }]);
        expect((await catalog('k-read')).body.data.Home).toEqual({ b1: { A: null, B: null } });
    });

    it('an uncategorised block registers and reads back under __uncategorized__, beside uncategorised phrases', async () => {
        await register('k-write', [
            { type: 'content_block', custom_id: 'b0', category: '', phrases: [{ phrase: 'Loose' }] },
            { type: 'content_block', custom_id: 'b1', phrases: [{ phrase: 'No key at all' }] },
            phrase('Plain', null),
        ]);
        expect((await catalog('k-read')).body.data.__uncategorized__).toEqual({
            Plain: null,
            b0: { Loose: null },
            b1: { 'No key at all': null },
        });
    });

    it('the regression knob reproduces the backend dropping that block: 200 and nothing stored', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, drop_uncategorized_blocks: true } });
        const res = await register('k-write', [{ type: 'content_block', custom_id: 'b0', category: '', phrases: [{ phrase: 'Loose' }] }]);
        expect(res.status).toBe(200);
        expect((await fx.state()).projects.p1.blocks).toEqual([]);
    });

    it('an empty project answers data as [], not {}', async () => {
        expect((await catalog('k-other', 'p2', 'fr-fr')).body).toMatchObject({ data: [], words: 0, untranslated_words: 0 });
    });
});

describe('the catalog serves a phrase at the base locale as the backend does, and an untranslatable one as null', () => {
    // TranslationService::generateTranslationsData, over the translatable flag registration
    // stores (TranslatableItemService, PhraseAnalyzer), at langsys fec9d822.
    const atBase = async () => (await catalog('k-read', 'p1', 'en-us')).body;
    const flagged = (text: string, translatable: boolean) => ({ ...phrase(text), translatable });

    it('at the base locale a translatable phrase is its own text; at a target locale it waits for its translation', async () => {
        await register('k-write', [phrase('Brand new')]);
        expect((await atBase()).data.UI).toEqual({ Hello: 'Hello', 'Brand new': 'Brand new' });
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola', 'Brand new': null });
    });

    it('a phrase sent as untranslatable is null at the base locale too; control: the same text sent without the flag', async () => {
        await register('k-write', [flagged('Acme', false), phrase('Acme', 'Brand')]);
        const data = (await atBase()).data;
        expect(data.UI.Acme).toBeNull();
        expect(data.Brand).toEqual({ Acme: 'Acme' });
    });

    it.each([
        ['https://acme.example/docs?q=1', null],
        ['HTTPS://EXAMPLE.COM/docs', null],
        ['ftp://files.acme.example', null],
        ['mailto:support@acme.example', null],
        ['tel:+15551234', null],
        ['support@acme.com', null],
        ['acme.com', null],
        ['rate_limit_exceeded', null],
        ['2500', null],
        ['1e10', null],
        ['1E10', null],
        ['NT$2500', null],
        ['5 USD', null],
        ['12:30:45', null],
        [':-D', null],
        ['🎉 100', null],
        ['2.5 - 11.5', '2.5 - 11.5'],
        ['$5.00', '$5.00'],
        ['Hello.World', 'Hello.World'],
        ['USDA approved', 'USDA approved'],
        ['EURUSD', 'EURUSD'],
        ['100USD', '100USD'],
        ['USD100', 'USD100'],
        ['Visit https://acme.com today', 'Visit https://acme.com today'],
        ['well-known', 'well-known'],
        ['C', 'C'],
    ])('text with nothing to translate is untranslatable, as PhraseAnalyzer reads it: %j', async (text, atBaseLocale) => {
        await register('k-write', [phrase(text)]);
        expect((await atBase()).data.UI[text]).toBe(atBaseLocale);
    });

    it('a stored ICU message is served at the base locale in place of the phrase; control: other stored text is not', async () => {
        await fx.seed({
            ...BASE_SEED,
            projects: [
                {
                    ...BASE_SEED.projects[0],
                    phrases: [
                        { category: 'UI', phrase: '{count} files', translations: { 'en-us': '{count, plural, one {# file} other {# files}}' } },
                        { category: 'UI', phrase: '{gender} replied', translations: { 'en-us': '{gender, select, female {She replied} other {They replied}}' } },
                        { category: 'UI', phrase: 'Welcome', translations: { 'en-us': 'Hi there' } },
                    ],
                },
                BASE_SEED.projects[1],
            ],
        });
        expect((await atBase()).data.UI).toEqual({
            '{count} files': '{count, plural, one {# file} other {# files}}',
            '{gender} replied': '{gender, select, female {She replied} other {They replied}}',
            Welcome: 'Welcome',
        });
    });

    it('a content block’s phrases follow the same rule', async () => {
        await register('k-write', [
            { type: 'content_block', custom_id: 'b1', category: 'Home', content: '<p/>', phrases: [{ phrase: 'Read more' }, { phrase: 'https://acme.example' }, { phrase: 'Hidden', translatable: false }] },
        ]);
        expect((await atBase()).data.Home).toEqual({ b1: { 'Read more': 'Read more', 'https://acme.example': null, Hidden: null } });
        expect((await catalog('k-read')).body.data.Home).toEqual({ b1: { 'Read more': null, 'https://acme.example': null, Hidden: null } });
    });

    it('a block registered again holds its phrases with the flags it is sent with', async () => {
        const block = (hidden: boolean) => ({ type: 'content_block', custom_id: 'b1', category: 'Home', content: '<p/>', phrases: [{ phrase: 'Read more' }, { phrase: 'Hidden', translatable: hidden }] });
        await register('k-write', [block(false)]);
        expect((await atBase()).data.Home.b1.Hidden).toBeNull();
        await register('k-write', [block(true)]);
        expect((await atBase()).data.Home.b1.Hidden).toBe('Hidden');
    });

    it('untranslated words count only the translatable phrases served null', async () => {
        // The total is not asserted: the backend counts words its own way (README, Not modelled).
        await register('k-write', [phrase('Two words'), phrase('https://acme.example')]);
        expect((await atBase()).untranslated_words).toBe(0);
        expect((await catalog('k-read')).body.untranslated_words).toBe(2);
    });

    it('registering a held phrase again sets its flag from the batch’s last occurrence; a new one takes its first', async () => {
        await register('k-write', [flagged('Acme', false)]);
        expect((await atBase()).data.UI.Acme).toBeNull();
        await register('k-write', [phrase('Acme')]);
        expect((await atBase()).data.UI.Acme).toBe('Acme');
        await register('k-write', [flagged('Acme', false), phrase('Acme')]);
        await register('k-write', [flagged('Fresh', false), phrase('Fresh')]);
        expect((await atBase()).data.UI).toMatchObject({ Acme: 'Acme', Fresh: null });
    });

    it('a seeded phrase is held as registration would hold it', async () => {
        await fx.seed({
            ...BASE_SEED,
            projects: [
                {
                    ...BASE_SEED.projects[0],
                    phrases: [{ category: 'UI', phrase: 'acme.com' }, { category: 'UI', phrase: 'Acme', translatable: false }, { category: 'UI', phrase: 'Plain' }],
                    blocks: [{ category: 'Home', custom_id: 'b1', phrases: [{ phrase: 'Shown' }, { phrase: 'Kept', translatable: false }] }],
                },
                BASE_SEED.projects[1],
            ],
        });
        const data = (await atBase()).data;
        expect(data.UI).toEqual({ 'acme.com': null, Acme: null, Plain: 'Plain' });
        expect(data.Home).toEqual({ b1: { Shown: 'Shown', Kept: null } });
    });

    it('the state reports each phrase’s flag', async () => {
        await register('k-write', [flagged('Acme', false), phrase('Plain')]);
        const held = (await fx.state()).projects.p1.phrases.map(({ phrase, translatable }) => ({ phrase, translatable }));
        expect(held).toEqual([
            { phrase: 'Hello', translatable: true },
            { phrase: 'Acme', translatable: false },
            { phrase: 'Plain', translatable: true },
        ]);
    });
});

describe('translations sent with the phrases are stored as human translations (MIG-9)', () => {
    // ProvidedTranslationService at langsys main 17a191cd.
    const QUOTA_SEED = {
        ...BASE_SEED,
        projects: [{ ...BASE_SEED.projects[0], target_locales: ['es-es', 'fr-fr'], human_translation_word_limit: 3 }, BASE_SEED.projects[1]],
    };
    const withTranslations = (text: string, translations: Record<string, string>, extra: Record<string, unknown> = {}) => ({
        ...phrase(text),
        translations,
        ...extra,
    });

    it('a target locale is stored, served on a later catalog read, and counted as saved', async () => {
        const res = await register('k-write', [withTranslations('Home', { 'es-es': 'Inicio' })]);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: true, data: { human_translations_saved: 1, human_translations_skipped: 0 } });
        expect((await catalog('k-read')).body.data.UI).toMatchObject({ Home: 'Inicio' });
    });

    it('a locale the project does not translate into is 422 on translations.<index>, and nothing is written', async () => {
        const res = await register('k-write', [phrase('First'), withTranslations('Home', { 'es-es': 'Inicio', it_IT: 'Casa' })]);
        expect(res.status).toBe(422);
        expect(res.body).toEqual({
            status: false,
            error: {
                message: 'The request failed validation.',
                code: 'validation_failed',
                template: 'The request failed validation.',
                errors: [
                    {
                        field: 'translatable_items.1.translations',
                        code: 'invalid_option',
                        message: 'The locale it-it is not a target locale of this project.',
                        template: 'The locale {locale} is not a target locale of this project.',
                        params: { locale: 'it-it' },
                    },
                ],
            },
        });
        const ui = (await catalog('k-read')).body.data.UI;
        expect(ui).not.toHaveProperty('First');
        expect(ui).not.toHaveProperty('Home');
    });

    it('control: the same request with only target locales is accepted', async () => {
        const res = await register('k-write', [phrase('First'), withTranslations('Home', { 'es-es': 'Inicio' })]);
        expect(res.status).toBe(200);
        expect((await catalog('k-read')).body.data.UI).toMatchObject({ First: null, Home: 'Inicio' });
    });

    it('the base locale is not a target locale', async () => {
        expect((await register('k-write', [withTranslations('Home', { 'en-us': 'Home' })])).status).toBe(422);
    });

    it('a phrase whose text has nothing to translate stores the translation sent with it, and is served null', async () => {
        // ProvidedTranslationService skips only an item sent with `translatable: false`.
        const res = await register('k-write', [withTranslations('acme.com', { 'es-es': 'acme.es' })]);
        expect(res.body.data).toEqual({ human_translations_saved: 1, human_translations_skipped: 0 });
        expect((await catalog('k-read')).body.data.UI['acme.com']).toBeNull();
        expect((await fx.state()).projects.p1.phrases.find((p) => p.phrase === 'acme.com')!.translations).toEqual({ 'es-es': 'acme.es' });
    });

    it('a content block ignores the map, and so does an untranslatable phrase', async () => {
        const res = await register('k-write', [
            { type: 'content_block', category: 'UI', custom_id: 'b1', content: '<p>A</p>', phrases: [{ phrase: 'Block A' }], translations: { 'es-es': 'Bloque' } },
            withTranslations('Brand', { 'es-es': 'Marca' }, { translatable: false }),
        ]);
        expect(res.body.data).toEqual({ human_translations_saved: 0, human_translations_skipped: 0 });
        const ui = (await catalog('k-read')).body.data.UI;
        expect(ui.b1).toEqual({ 'Block A': null });
        expect(ui.Brand).toBeNull();
    });

    it('a refused write stores no translation either', async () => {
        await register('k-read', [withTranslations('Home', { 'es-es': 'Inicio' })]);
        expect((await catalog('k-read')).body.data.UI).not.toHaveProperty('Home');
    });

    it('the quota: a new translation past what is left is skipped, and one within it is saved', async () => {
        await fx.seed(QUOTA_SEED);
        // Two words each, three allowed: es-es fits, fr-fr would be four.
        const res = await register('k-write', [withTranslations('Hello there', { 'es-es': 'Hola', 'fr-fr': 'Salut' })]);
        expect(res.body.data).toEqual({ human_translations_saved: 1, human_translations_skipped: 1 });
        expect((await catalog('k-read', 'p1', 'es-es')).body.data.UI['Hello there']).toBe('Hola');
        expect((await catalog('k-read', 'p1', 'fr-fr')).body.data.UI['Hello there']).toBeNull();
        expect((await fx.state()).projects.p1.human_translation_words_used).toBe(2);
    });

    it('control: replacing a translation the phrase has is an update, and counts nothing even with the quota spent', async () => {
        await fx.seed({ ...QUOTA_SEED, projects: [{ ...QUOTA_SEED.projects[0], human_translation_words_used: 3 }, BASE_SEED.projects[1]] });
        const res = await register('k-write', [withTranslations('Hello', { 'es-es': 'Buenas' })]);
        expect(res.body.data).toEqual({ human_translations_saved: 1, human_translations_skipped: 0 });
        expect((await catalog('k-read')).body.data.UI.Hello).toBe('Buenas');
        expect((await fx.state()).projects.p1.human_translation_words_used).toBe(3);
    });

    it('uncapped by default', async () => {
        const res = await register('k-write', [withTranslations('Hello there friend', { 'es-es': 'Hola amigo' })]);
        expect(res.body.data).toEqual({ human_translations_saved: 1, human_translations_skipped: 0 });
    });
});

describe('errors are the backend’s at langsys main 17a191cd: status, envelope, code, and check order', () => {
    const code = (res: { body: { error: { code: string } } }) => res.body.error.code;
    const E = (c: string, message: string) => ({ status: false, error: { message, code: c, template: message } });

    it('every refusal on the API-key path names its case', async () => {
        expect((await catalog('')).body).toEqual(E('unauthenticated', 'Unauthenticated.'));
        expect((await api('/authorize-project/p1')).body).toEqual(E('unauthenticated', 'Unauthenticated.'));
        expect((await catalog('nope')).body).toEqual(E('api_key_invalid', 'Invalid API key'));
        expect(code(await catalog('k-orphan'))).toBe('api_key_invalid');
        expect((await api('/authorize-project/p2', { key: 'k-read' })).body).toEqual(E('api_key_invalid', 'Invalid API key'));
        expect((await register('k-read', [phrase('Refused')])).body).toEqual(E('api_key_write_not_allowed', 'This API key cannot make write requests.'));
        expect((await catalog('k-read', 'p2')).body).toEqual(E('forbidden', 'Forbidden.'));
    });

    it('a suspended project tells a write key why, and any other key only that it is unavailable', async () => {
        await fx.seed({ ...BASE_SEED, projects: [{ ...BASE_SEED.projects[0], subscription_suspended: true }, BASE_SEED.projects[1]] });
        expect(code(await catalog('k-write'))).toBe('subscription_suspended');
        expect((await catalog('k-read')).body).toEqual(E('project_unavailable', 'This project is not available. Its owners can see why in Langsys.'));
    });

    it('an exhausted balance is api_units_limit_exceeded, and wins over a missing project_id', async () => {
        await fx.seed({ ...BASE_SEED, keys: [{ key: 'k-broke', project: 'p1', type: 'write', usage_exhausted: true }] });
        const res = await api('/translatable-items', { key: 'k-broke', body: { translatable_items: [] } });
        expect(res.status).toBe(402);
        expect(code(res)).toBe('api_units_limit_exceeded');
    });

    it('an unknown project is 404 before the key is checked, on every route; no key at all is 401 first on the catalog', async () => {
        expect((await catalog('nope', 'p-unknown')).body).toEqual(E('not_found', 'Resource not found'));
        expect((await api('/authorize-project/p-unknown', { key: 'nope' })).status).toBe(404);
        expect((await catalog('', 'p-unknown')).status).toBe(401);
    });

    it('validation failures carry one entry per failed rule', async () => {
        const noLocale = await api('/translations?project_id=p1', { key: 'k-read' });
        expect(noLocale.status).toBe(422);
        expect(noLocale.body.error).toMatchObject({ code: 'validation_failed', errors: [{ field: 'locale', code: 'invalid_option', message: 'The locale is not valid.' }] });
        const both = await api('/translatable-items', { key: 'k-write', body: { translatable_items: 'x' } });
        expect(both.body.error.errors).toEqual([
            { field: 'project_id', code: 'required', message: 'The project is required.', template: 'The project is required.' },
            { field: 'translatable_items', code: 'invalid_type', message: 'The translatable items must be a list.', template: 'The translatable items must be a list.' },
        ]);
        const noUrl = await api('/discovery/hint', { body: {} });
        expect(noUrl.body.error.errors).toEqual([{ field: 'page_url', code: 'required', message: 'The page URL is required.', template: 'The page URL is required.' }]);
        const long = await api('/discovery/hint', { body: { page_url: 'not a url ' + 'x'.repeat(2050) } });
        expect(long.body.error.errors.map((e: { code: string }) => e.code)).toEqual(['invalid_format', 'too_long']);
        expect(long.body.error.errors[1]).toMatchObject({ template: 'The page URL must not be longer than {max} characters.', params: { max: 2048 } });
    });

    it('an over-limit batch is batch_size_exceeded, with its limit and count as details', async () => {
        const res = await register('k-write', [phrase('a'), phrase('b'), phrase('c'), phrase('d')]);
        expect(res.body).toEqual({
            status: false,
            error: {
                message: 'The request has more translatable items than one batch allows.',
                code: 'batch_size_exceeded',
                template: 'The request has more translatable items than one batch allows.',
                details: { limit: 3, item_count: 4 },
            },
        });
    });

    it('a body that is not JSON reads as empty, and the route’s own validation answers', async () => {
        const res = await fetch(fx.baseUrl + '/discovery/hint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
        expect(res.status).toBe(422);
        expect((await res.json()).error.errors[0]).toMatchObject({ field: 'page_url', code: 'required' });
    });

    it('a known route with the wrong method is 405, and an unknown route 404', async () => {
        expect((await api('/translatable-items', { key: 'k-write' })).body).toEqual(E('method_not_allowed', 'The requested method is not allowed for this route.'));
        expect(code(await api('/no-such-route', { key: 'k-write' }))).toBe('not_found');
    });

    it('the duplicate guard and the hint throttle name their cases', async () => {
        await fx.seed({ ...BASE_SEED, keys: [...BASE_SEED.keys, { key: 'k-dup', project: 'p1', type: 'read', duplicate_guard: { max_attempts: 1, window_seconds: 60 } }] });
        await catalog('k-dup');
        expect(code(await catalog('k-dup'))).toBe('duplicate_request');
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, hint_rate_per_minute: 1 } });
        await hint(undefined, 'https://www.site.local/a');
        expect((await hint(undefined, 'https://www.site.local/b')).body).toEqual(E('too_many_requests', 'Too many requests. Please try again later.'));
    });

    it('an injected status renders as the case the backend maps it to, and any other as internal_error', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'GET', path: '/translations', status: 503 }, { method: 'GET', path: '/translations', status: 418 }] });
        const unavailable = await catalog('k-read');
        expect([unavailable.status, code(unavailable)]).toEqual([503, 'service_unavailable']);
        const teapot = await catalog('k-read');
        expect([teapot.status, code(teapot)]).toEqual([418, 'internal_error']);
    });
});

describe('write_enabled is computed from key, address and grant', () => {
    const writeEnabled = async (key: string, grant?: string) => (await api('/authorize-project/p1', { key, grant })).body.data.write_enabled;

    it('by key type', async () => {
        expect(await writeEnabled('k-write')).toBe(true);
        expect(await writeEnabled('k-read')).toBe(false);
    });

    it('an ip_write key writes from an allow-listed address and not from another', async () => {
        expect(await writeEnabled('k-ipw-local')).toBe(true);
        expect(await writeEnabled('k-public')).toBe(false);
        expect((await register('k-ipw-local', [phrase('Via IP')])).status).toBe(200);
        expect((await register('k-public', [phrase('Via IP')])).status).toBe(403);
    });

    it('a valid grant makes a read key write-enabled, on authorize, on the catalog envelope and for a write', async () => {
        const grant = signGrant('grant-secret', { sub: 'user-1', exp: nowSeconds() + 300 });
        expect(await writeEnabled('k-grant', grant)).toBe(true);
        expect((await api('/translations?project_id=p1&locale=es-es', { key: 'k-grant', grant })).body.write_enabled).toBe(true);
        expect((await api('/translatable-items', { key: 'k-grant', grant, body: { project_id: 'p1', translatable_items: [phrase('Granted')] } })).status).toBe(200);
    });

    it('an invalid grant does not: wrong secret, no exp, no sub, on a key with no secret', async () => {
        const exp = nowSeconds() + 300;
        expect(await writeEnabled('k-grant', signGrant('wrong', { sub: 'u', exp }))).toBe(false);
        expect(await writeEnabled('k-grant', signGrant('grant-secret', { sub: 'u' }))).toBe(false);
        expect(await writeEnabled('k-grant', signGrant('grant-secret', { exp }))).toBe(false);
        expect(await writeEnabled('k-read', signGrant('grant-secret', { sub: 'u', exp }))).toBe(false);
    });

    it('a grant expires, with 60 seconds of leeway', async () => {
        const grant = signGrant('grant-secret', { sub: 'u', exp: nowSeconds() + 30 });
        expect(await writeEnabled('k-grant', grant)).toBe(true);
        await fx.advanceClock(60);
        expect(await writeEnabled('k-grant', grant), 'inside the leeway').toBe(true);
        await fx.advanceClock(60);
        expect(await writeEnabled('k-grant', grant), 'past it').toBe(false);
    });

    it('a legacy server omits write_enabled and auto_discovery everywhere', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, legacy_omit_capability: true } });
        const auth = (await api('/authorize-project/p1', { key: 'k-write' })).body.data;
        expect(auth).not.toHaveProperty('write_enabled');
        expect(auth).not.toHaveProperty('auto_discovery');
        expect(auth).not.toHaveProperty('discovery_base_locale_only');
        expect(auth.key_type).toBe('write');
        expect((await catalog('k-write')).body).not.toHaveProperty('write_enabled');
    });

    it('serves discovery_base_locale_only inside authorize data and beside data on both catalog routes, default false', async () => {
        expect((await api('/authorize-project/p1', { key: 'k-read' })).body.data.discovery_base_locale_only).toBe(false);
        const projects = [{ ...BASE_SEED.projects[0], discovery_base_locale_only: true }, BASE_SEED.projects[1]];
        await fx.seed({ ...BASE_SEED, projects });
        expect((await api('/authorize-project/p1', { key: 'k-read' })).body.data.discovery_base_locale_only).toBe(true);
        for (const route of ['/translations', '/translations/data']) {
            const body = (await api(`${route}?project_id=p1&locale=es-es`, { key: 'k-read' })).body;
            expect(body.discovery_base_locale_only, route).toBe(true);
            expect(body.data, `${route}: never inside the cached map`).not.toHaveProperty('discovery_base_locale_only');
        }
    });
});

describe('hints follow the backend acceptance rules, and only an accepted hint is stored', () => {
    const stored = async () => (await fx.state()).hints;

    it('the canonical public site reports, normalised as the backend normalises', async () => {
        const res = await hint('k-public', 'https://site.local/pricing?utm_source=x&b=2&a=1#features');
        expect(res.status).toBe(204);
        expect(await stored()).toEqual([{ project_id: 'p1', url: 'https://site.local/pricing?a=1&b=2' }]);
    });

    it('answers 204 and stores nothing for an unknown key, a writer, a key not permitted to report, and a foreign host', async () => {
        for (const [key, url] of [
            ['nope', 'https://site.local/a'],
            ['k-write', 'https://site.local/b'],
            ['k-ipw-local', 'https://site.local/c'],
            ['k-grant', 'https://site.local/d'],
            ['k-public', 'https://elsewhere.local/e'],
        ] as const) {
            expect((await hint(key, url)).status, `${key} ${url}`).toBe(204);
        }
        expect(await stored()).toEqual([]);
        // Control: the same session, on its own host, is stored.
        await hint('k-public', 'https://shop.site.local/f');
        expect(await stored()).toHaveLength(1);
    });

    it('a caller that can write is not stored even when it may report; the same key reports once it cannot write', async () => {
        await hint('k-writer-reporter', 'https://site.local/writer');
        expect(await stored()).toEqual([]);
        const keys = BASE_SEED.keys.map((k) => (k.key === 'k-writer-reporter' ? { ...k, ip_allowlist: [] } : k));
        await fx.seed({ ...BASE_SEED, keys });
        await hint('k-writer-reporter', 'https://site.local/writer');
        expect(await stored()).toEqual([{ project_id: 'p1', url: 'https://site.local/writer' }]);
    });

    it('dedups the same key and URL within the TTL, folding #!/ into #/, and accepts again after it', async () => {
        await hint('k-public', 'https://site.local/#!/checkout');
        await hint('k-public', 'https://site.local/#/checkout');
        expect(await stored()).toHaveLength(1);
        await fx.advanceClock(61);
        await hint('k-public', 'https://site.local/#/checkout');
        expect(await stored()).toHaveLength(2);
    });

    it('a project that does not translate new content, or has no credits, stores nothing', async () => {
        const projects = [{ ...BASE_SEED.projects[0], machine_translate_new_phrases: false }, BASE_SEED.projects[1]];
        await fx.seed({ ...BASE_SEED, projects });
        await hint('k-public', 'https://site.local/g');
        await fx.seed({ ...BASE_SEED, projects: [{ ...BASE_SEED.projects[0], credits_exhausted: true }, BASE_SEED.projects[1]] });
        await hint('k-public', 'https://site.local/h');
        expect(await stored()).toEqual([]);
    });

    it('limits per source address with 429, and a rate-limited hint is not stored', async () => {
        await fx.seed({ ...BASE_SEED, config: { ...BASE_SEED.config, hint_rate_per_minute: 5 } });
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) statuses.push((await hint('k-public', `https://site.local/p${i}`)).status);
        expect(statuses).toEqual([204, 204, 204, 204, 204, 429]);
        expect(await stored()).toHaveLength(5);
    });

    it('rejects a page_url that is not a URL with 422', async () => {
        expect((await hint('k-public', 'not a url')).status).toBe(422);
    });
});

describe('faults are deterministic and consumed in order', () => {
    it('a status fault answers once, then the route behaves normally', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'POST', path: '/translatable-items', times: 1, status: 500 }] });
        expect((await register('k-write', [phrase('Retry me')])).status).toBe(500);
        expect((await fx.state()).projects.p1.phrases.map((p) => p.phrase)).not.toContain('Retry me');
        expect((await register('k-write', [phrase('Retry me')])).status).toBe(200);
        expect((await fx.state()).projects.p1.phrases.map((p) => p.phrase)).toContain('Retry me');
    });

    it('a body fault answers that raw body once, as something in front of the API would, then the route answers', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'GET', path: '/translations', body: '<html>gateway</html>', content_type: 'text/html', status: 502 }] });
        const proxied = await fetch(fx.baseUrl + '/translations?project_id=p1&locale=es-es', { headers: { 'x-authorization': 'k-read' } });
        expect(proxied.status).toBe(502);
        expect(proxied.headers.get('content-type')).toBe('text/html');
        expect(await proxied.text()).toBe('<html>gateway</html>');
        expect((await catalog('k-read')).body.data.UI).toEqual({ Hello: 'Hola' });
    });

    it('a drop fault closes the connection without a response', async () => {
        await fx.seed({ ...BASE_SEED, faults: [{ method: 'GET', path: '/translations', drop: true }] });
        await expect(catalog('k-read')).rejects.toThrow();
        expect((await catalog('k-read')).status).toBe(200);
    });
});

describe('the duplicate-request guard applies only to keys configured for it', () => {
    it('the fourth identical request inside the window is 429', async () => {
        await fx.seed({ ...BASE_SEED, keys: [...BASE_SEED.keys, { key: 'k-guarded', project: 'p1', type: 'read', duplicate_guard: { max_attempts: 3, window_seconds: 1 } }] });
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) statuses.push((await catalog('k-guarded')).status);
        expect(statuses).toEqual([200, 200, 200, 429]);
        const unguarded: number[] = [];
        for (let i = 0; i < 4; i++) unguarded.push((await catalog('k-read')).status);
        expect(unguarded).toEqual([200, 200, 200, 200]);
    });
});

describe('the reference lists, as LocaleController, CountryController and CurrencyController answer them', () => {
    // The organisation's code format is per project; p1 targets es-es and p2 fr-fr.
    const REFERENCE = {
        locales: ['fr-fr', 'es-es', 'es-cr', 'en-us'],
        countries: [{ code: 'ES' }, { code: 'CR' }, { code: 'US' }],
        dial_codes: [{ country_code: 'ES', dial_code: '34' }, { country_code: 'CR', dial_code: '506' }],
        currencies: [
            { code: 'EUR', name: 'Euro (stored)', symbol: '€' },
            { code: 'CRC', name: 'Colón (stored)', symbol: '₡' },
            // A code ICU has no entry for, so Symfony Intl throws and the stored name is kept.
            { code: 'XYZ', name: 'Test currency (stored)', symbol: 'X' },
        ],
    };
    const seedWith = (format = 'lowercase-hyphen', reference: unknown = REFERENCE) =>
        fx.seed({ ...BASE_SEED, projects: BASE_SEED.projects.map((p) => (p.id === 'p2' ? { ...p, locale_code_format: format } : p)), reference });
    const code = (res: { body: { error: { code: string } } }) => res.body.error.code;
    const keysOf = (res: { body: { data: unknown } }) => (Array.isArray(res.body.data) ? res.body.data : Object.keys(res.body.data as object));
    const flat = (query: string, key = 'k-other') => api(`/locales/flat?${query}`, { key });
    const q = (locale: string, extra = '') => `locales%5B%5D=${locale}${extra}`;

    it('no key is 401, an unknown key 403, on every reference route; a real key reads', async () => {
        await seedWith();
        for (const path of ['/locales', '/locales/flat', '/locales/data', '/countries/es-es', '/countries/dial-codes/es-es', '/currencies/es-es']) {
            expect(code(await api(path)), path).toBe('unauthenticated');
            expect(code(await api(path, { key: 'k-unknown' })), path).toBe('api_key_invalid');
            expect((await api(path, { key: 'k-read' })).status, path).toBe(200);
        }
    });

    it('a display locale appends the key’s target locales unless append_target_locales is false', async () => {
        await seedWith();
        expect(keysOf(await flat(q('es-es')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=1')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=true')))).toEqual(['es-es', 'fr-fr']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es-es', '&append_target_locales=false')))).toEqual(['es-es']);
    });

    it('locales/data names the requested locales in the table’s order, so an appended one can come first', async () => {
        await seedWith();
        expect(keysOf(await api(`/locales/data?${q('es-es')}`, { key: 'k-other' }))).toEqual(['fr-fr', 'es-es']);
        expect(keysOf(await api(`/locales/data?${q('es-es', '&append_target_locales=0')}`, { key: 'k-other' }))).toEqual(['es-es']);
    });

    it('a project_id appends its target locales whatever the flag, and one the key does not belong to is 403', async () => {
        await seedWith();
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0&project_id=p2')))).toEqual(['es-es', 'fr-fr']);
        expect(code(await flat(q('es-es', '&append_target_locales=0&project_id=p1')))).toBe('forbidden');
    });

    it('append_target_locales other than true, false, 1 or 0, and locales that is not a list, are 422', async () => {
        await seedWith();
        const res = await flat('locales=es-es&append_target_locales=yes');
        expect(res.status).toBe(422);
        expect(res.body.error.errors.map((e: { field: string; code: string }) => `${e.field} ${e.code}`)).toEqual([
            'locales invalid_type',
            'append_target_locales invalid_type',
        ]);
    });

    it('a locale the table does not hold names nothing, and an empty answer is data: []', async () => {
        await seedWith();
        expect((await flat(q('xx-yy', '&append_target_locales=0'))).body).toEqual({ status: true, data: [] });
        expect(keysOf(await flat(q('es-es', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('request-dto-processor formats locales[] as UsesLocales::formatLocale does, `_` to `-` and lowercased', async () => {
        await seedWith();
        expect(keysOf(await flat(q('ES-ES', '&append_target_locales=0')))).toEqual(['es-es']);
        expect(keysOf(await flat(q('es_ES', '&append_target_locales=0')))).toEqual(['es-es']);
    });

    it('request-dto-processor refuses a query key LocalesIndexRequest does not declare, and accepts every one it does', async () => {
        await seedWith();
        const refused = await flat(q('es-es', '&append_target_locales=0&format=flat'));
        expect(refused.status).toBe(422);
        expect(refused.body.error.errors).toEqual([{ field: 'format', code: 'not_allowed', message: 'This field is not allowed.', template: 'This field is not allowed.' }]);
        expect((await flat(q('es-es', '&append_target_locales=0&user_locale=es-es&project_id=p2'))).status).toBe(200);
        const two = await flat(q('es-es', '&zeta=1&alpha=1'));
        expect(two.body.error.errors.map((e: { field: string }) => e.field)).toEqual(['zeta', 'alpha']);
    });

    it('request-dto-processor runs after the API-key check and before the usage balance', async () => {
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, keys: [...BASE_SEED.keys, { key: 'k-spent', project: 'p1', type: 'read', usage_exhausted: true }] });
        expect(code(await flat(q('es-es', '&format=x'), 'k-unknown'))).toBe('api_key_invalid');
        expect(code(await flat(q('es-es', '&format=x'), 'k-spent'))).toBe('validation_failed');
        expect(code(await flat(q('es-es'), 'k-spent'))).toBe('api_units_limit_exceeded');
    });

    it('query keys are read as PHP parses them: a bracketed key by its name, dots and spaces in a name as underscores', async () => {
        await seedWith();
        expect(keysOf(await flat('locales%5Ba%5D=es-es&append.target_locales=0'))).toEqual(['es-es']);
        const refused = await flat(q('es-es', '&foo%5Bbar%5D=1'));
        expect(refused.body.error.errors.map((e: { field: string }) => e.field)).toEqual(['foo']);
    });

    it('query keys are read as PHP parses them: leading spaces dropped, a key with no name dropped, the last key deciding the shape of locales', async () => {
        await seedWith();
        const fields = (res: { body: { error: { errors: { field: string }[] } } }) => res.body.error.errors.map((e) => e.field);
        expect(keysOf(await flat(`%20${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        // A name with a space inside is still a field of its own, and undeclared.
        expect(fields(await flat(`lo%20cales%5B%5D=es-es&append_target_locales=0`))).toEqual(['lo_cales']);
        expect(keysOf(await flat(`%5Bx%5D=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(fields(await flat(`x%5B%5D=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['x']);
        expect(keysOf(await flat(`locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        const scalar = await flat(`${q('es-es')}&locales=x&append_target_locales=0`);
        expect(scalar.body.error.errors).toEqual([expect.objectContaining({ field: 'locales', code: 'invalid_type' })]);
        expect(keysOf(await flat(`${q('fr-fr')}&locales=x&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        // A key with no name at all is dropped too, as one with a name is not.
        expect(keysOf(await flat(`=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['es-es']);
        expect(fields(await flat(`x=1&${q('es-es', '&append_target_locales=0')}`))).toEqual(['x']);
    });

    it('a locales index is a key, as PHP keys an array: a repeated index keeps its last value, and an empty locales is none', async () => {
        await seedWith();
        const at = (index: string, locale: string) => `locales%5B${index}%5D=${locale}`;
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('', 'fr-fr')}&${at('0', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        expect(keysOf(await flat(`${at('a', 'fr-fr')}&${at('a', 'es-es')}&append_target_locales=0`))).toEqual(['es-es']);
        // Two indexes keep two values; the table orders them.
        expect(keysOf(await flat(`${at('0', 'fr-fr')}&${at('1', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        expect(keysOf(await flat(`${at('5', 'fr-fr')}&${at('', 'es-es')}&append_target_locales=0`))).toEqual(['fr-fr', 'es-es']);
        // An empty locales is null after ConvertEmptyStringsToNull, so it asks for none.
        for (const empty of ['locales=', 'locales', 'locales=%20', `${q('es-es')}&locales=`]) {
            const res = await flat(`${empty}&append_target_locales=0`);
            expect(res.status, empty).toBe(200);
            expect(keysOf(res), empty).toEqual([]);
        }
        expect((await flat('locales=x&append_target_locales=0')).status).toBe(422);
    });

    it('each display locale names the lists in its own language, with the organisation’s code format on keys and codes', async () => {
        await seedWith('posix');
        const es = (await flat(q('es-es', '&append_target_locales=0'))).body.data;
        expect(Object.keys(es)).toEqual(['es_ES']);
        expect(es.es_ES).toContainEqual({ code: 'es_CR', name: 'Español (Costa Rica)' });
        const fr = (await flat(q('fr-fr', '&append_target_locales=0'))).body.data;
        expect(fr.fr_FR).toContainEqual({ code: 'es_CR', name: 'Espagnol (Costa Rica)' });
        await seedWith('bcp47');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-ES']);
        await seedWith('lowercase-hyphen');
        expect(Object.keys((await flat(q('es-es', '&append_target_locales=0'))).body.data)).toEqual(['es-es']);
    });

    it('the grouped form groups by language name, and the data form carries both names', async () => {
        await seedWith();
        const grouped = (await api(`/locales?${q('en-us', '&append_target_locales=0')}`, { key: 'k-read' })).body.data['en-us'];
        expect(Object.keys(grouped)).toEqual(['English', 'French', 'Spanish']);
        expect(grouped.Spanish).toEqual([
            { code: 'es-cr', name: 'Spanish (Costa Rica)' },
            { code: 'es-es', name: 'Spanish (Spain)' },
        ]);
        const data = (await api(`/locales/data?${q('en-us', '&append_target_locales=0')}`, { key: 'k-read' })).body.data['en-us'];
        expect(data).toContainEqual({ code: 'es-es', locale_name: 'Spanish (Spain)', lang_name: 'Spanish' });
    });

    it('countries, dial codes and currencies are the list itself, named in the display locale; codes stay as stored', async () => {
        await seedWith('posix');
        const countries = (await api('/countries/es-es', { key: 'k-other' })).body;
        expect(countries).toEqual({
            status: true,
            data: [
                { label: 'Costa Rica', code: 'CR', eu: false },
                { label: 'España', code: 'ES', eu: true },
                { label: 'Estados Unidos', code: 'US', eu: false },
            ],
        });
        expect((await api('/countries/en-us', { key: 'k-other' })).body.data.map((c: { label: string }) => c.label)).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await api('/countries/dial-codes/fr-fr', { key: 'k-other' })).body.data).toEqual([
            { country_code: 'CR', dial_code: '506', name: 'Costa Rica (+506)' },
            { country_code: 'ES', dial_code: '34', name: 'Espagne (+34)' },
        ]);
        expect((await api('/currencies/es-es', { key: 'k-other' })).body.data.map((c: { name: string }) => c.name)).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
    });

    it('edge display locales are named as the backend names them: root and und by code, an underscore read as a hyphen, Symfony’s currency chain', async () => {
        await seedWith();
        const labels = async (locale: string) => (await api(`/countries/${locale}`, { key: 'k-read' })).body.data.map((c: { label: string }) => c.label);
        const currencies = async (locale: string) => (await api(`/currencies/${locale}`, { key: 'k-read' })).body.data.map((c: { name: string }) => c.name);
        expect(await labels('es_ES')).toEqual(['Costa Rica', 'España', 'Estados Unidos']);
        expect(await labels('root')).toEqual(['CR', 'ES', 'US']);
        expect(await labels('und')).toEqual(['CR', 'ES', 'US']);
        // Symfony's root bundle names a few currencies, EUR among them, by code; for the rest it throws.
        expect(await currencies('root')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        expect(await labels('root_ES')).toEqual(['CR', 'ES', 'US']);
        expect(await currencies('root_ES')).toEqual(['EUR', 'Colón (stored)', 'Test currency (stored)']);
        // und with a region has no language: ICU names it in the host's default, and Symfony throws.
        expect(await labels('und_ES')).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect(await currencies('und_ES')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        // Symfony's fallback chain ends for a one-subtag locale of four or more letters, and for und.
        expect(await currencies('abcd')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await currencies('und')).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
        expect(await currencies('es_ES')).toEqual(['euro', 'colón costarricense', 'Test currency (stored)']);
    });

    it('a currency is named from the first Symfony bundle on the display locale’s chain that holds it, its locale matched by case as on the backend’s Linux hosts', async () => {
        await seedWith();
        const currencies = async (locale: string) => (await api(`/currencies/${locale}`, { key: 'k-read' })).body.data.map((c: { name: string }) => c.name);
        const named = (locale: string) => ['EUR', 'CRC'].map((code) => new Intl.DisplayNames([locale], { type: 'currency' }).of(code));
        const stored = 'Test currency (stored)';
        // zh_tw has neither a bundle nor an alias (Symfony's is zh_TW), so it falls back to zh,
        // Simplified; zh_TW's alias, and zh_hant_tw's fallback, reach zh_Hant, Traditional.
        expect(named('zh')).not.toEqual(named('zh-Hant'));
        expect(await currencies('zh-tw')).toEqual([...named('zh'), stored]);
        expect(await currencies('zh_TW')).toEqual([...named('zh-Hant'), stored]);
        expect(await currencies('zh-hant-tw')).toEqual([...named('zh-Hant'), stored]);
        // pt_pt drops its region to pt; sr_latn_ba drops to sr_Latn, and sr_ba to sr.
        expect(named('pt')).not.toEqual(named('pt-PT'));
        expect(await currencies('pt-pt')).toEqual([...named('pt'), stored]);
        expect(await currencies('sr-latn-ba')).toEqual([...named('sr-Latn'), stored]);
        expect(await currencies('sr-ba')).toEqual([...named('sr'), stored]);
        // nb has no bundle, and tl's alias fil none: both fall back to en. iw's alias he has one.
        expect(await currencies('nb')).toEqual([...named('en'), stored]);
        expect(await currencies('tl')).toEqual([...named('en'), stored]);
        expect(await currencies('iw-il')).toEqual([...named('he'), stored]);
        // hi_latn_in drops its region to hi_Latn, whose bundle holds CRC and not EUR, so EUR is
        // named further along, in hi; hi_latn drops its script straight to hi.
        expect(await currencies('hi-latn-in')).toEqual([named('hi')[0], named('hi-Latn')[1], stored]);
        expect(await currencies('hi-latn')).toEqual([...named('hi'), stored]);
    });

    it('a display locale of und with two subtags more fails as the backend fails: Symfony throws a ValueError the controller does not catch', async () => {
        await seedWith();
        const res = await api('/currencies/und-latn-es', { key: 'k-read' });
        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('internal_error');
        expect((await api('/countries/und-latn-es', { key: 'k-read' })).status).toBe(200);
        // With one subtag more, Symfony throws a MissingResourceException, which keeps the stored names.
        expect((await api('/currencies/und-es', { key: 'k-read' })).body.data.map((c: { name: string }) => c.name)).toEqual(['Euro (stored)', 'Colón (stored)', 'Test currency (stored)']);
    });

    it('a display locale ICU has no data for is named in English, its fallback; a currency ICU cannot name keeps its stored name', async () => {
        await seedWith();
        expect((await api('/currencies/xx-yy', { key: 'k-read' })).body.data.map((c: { name: string }) => c.name)).toEqual(['Euro', 'Costa Rican Colón', 'Test currency (stored)']);
        expect((await api('/countries/xx-yy', { key: 'k-read' })).body.data.map((c: { label: string }) => c.label)).toEqual(['Costa Rica', 'Spain', 'United States']);
        expect((await flat(q('en-us', '&append_target_locales=0'))).body.data['en-us']).toContainEqual({ code: 'es-cr', name: 'Spanish (Costa Rica)' });
    });

    it('the lists are state: a reseeded table answers the new rows', async () => {
        await seedWith();
        expect((await api('/countries/en-us', { key: 'k-read' })).body.data).toHaveLength(3);
        await seedWith('lowercase-hyphen', { ...REFERENCE, countries: [{ code: 'FR' }] });
        expect((await api('/countries/en-us', { key: 'k-read' })).body.data).toEqual([{ label: 'France', code: 'FR', eu: true }]);
    });

    it('the deprecated locales/{locale}/{format} is not served, and a reference route takes GET only', async () => {
        await seedWith();
        expect(code(await api('/locales/es-es/data', { key: 'k-read' }))).toBe('not_found');
        expect(code(await api('/countries/es-es', { key: 'k-write', method: 'POST' }))).toBe('method_not_allowed');
        expect(code(await api('/locales', { key: 'k-write', method: 'POST' }))).toBe('method_not_allowed');
    });

    it('an exhausted balance is 402 on a reference route, and a suspended project refuses it', async () => {
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, keys: [...BASE_SEED.keys, { key: 'k-spent', project: 'p1', type: 'read', usage_exhausted: true }] });
        expect(code(await api('/countries/es-es', { key: 'k-spent' }))).toBe('api_units_limit_exceeded');
        expect((await api('/countries/es-es', { key: 'k-read' })).status).toBe(200);
        await fx.seed({ ...BASE_SEED, reference: REFERENCE, projects: BASE_SEED.projects.map((p) => (p.id === 'p1' ? { ...p, subscription_suspended: true } : p)) });
        expect(code(await api('/locales/flat?locales%5B%5D=es-es', { key: 'k-read' }))).toBe('project_unavailable');
    });

    it('a seed with a locale code format it does not know is refused', async () => {
        const res = await fetch(fx.fixtureUrl + '/seed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ projects: [{ id: 'p9', locale_code_format: 'upper' }] }),
        });
        expect(res.status).toBe(400);
    });
});

describe('the reference lists name an unknown display locale in English whatever the host’s locale', () => {
    // ICU's own fallback for a display locale it has no data for is the host's default locale.
    const SPANISH_HOST = { LANG: 'es_ES.UTF-8', LC_ALL: 'es_ES.UTF-8' };
    let spanish: ContractFixture;
    beforeAll(async () => {
        spanish = await startContractFixture(SPANISH_HOST);
    });
    afterAll(async () => {
        await spanish.stop();
    });

    it('control: on that host, ICU’s own fallback is Spanish', () => {
        const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(new Intl.DisplayNames(['zz'], { type: 'currency' }).of('EUR'))"], {
            env: { ...process.env, ...SPANISH_HOST },
            encoding: 'utf8',
        });
        expect(probe.stdout).toBe('euro');
    });

    it('a double on a Spanish host answers xx-yy in English, as a backend host whose ICU default is English does', async () => {
        await spanish.seed({
            projects: [{ id: 'p1' }],
            keys: [{ key: 'k1', project: 'p1', type: 'read' }],
            reference: { countries: [{ code: 'ES' }], currencies: [{ code: 'EUR', name: 'Euro (stored)' }] },
        });
        const read = async (path: string) => (await (await fetch(spanish.baseUrl + path, { headers: { 'x-authorization': 'k1' } })).json()).data;
        expect((await read('/currencies/xx-yy')).map((c: { name: string }) => c.name)).toEqual(['Euro']);
        expect((await read('/countries/xx-yy')).map((c: { label: string }) => c.label)).toEqual(['Spain']);
        expect((await read('/currencies/es-es')).map((c: { name: string }) => c.name)).toEqual(['euro']);
    });
});

describe('there is no request log', () => {
    it('state carries accepted state only, and no route returns what was received', async () => {
        await register('k-read', [phrase('Refused')]);
        await hint('k-write', 'https://site.local/declined');
        const state = await fx.state();
        expect(Object.keys(state).sort()).toEqual(['hints', 'projects']);
        expect(JSON.stringify(state)).not.toContain('Refused');
        expect(JSON.stringify(state)).not.toContain('declined');
        for (const route of ['/requests', '/log', '/history', '/calls']) {
            expect((await fetch(fx.fixtureUrl + route)).status, route).toBe(404);
        }
    });
});
