import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangsysAppAPI } from '../src/api.js';
import { createSignal } from '../src/signal.js';

function mockFetchOnce() {
    const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        url: 'http://test/api',
        json: async () => ({ data: {} }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function configure() {
    LangsysAppAPI.setup({
        projectid: 'proj-123',
        key: 'secret-key',
        sUserLocale: createSignal('en'),
        baseLocale: 'en',
    });
    LangsysAppAPI.setBaseUrl('http://test/api');
}

describe('LangsysAppAPI capability negotiation', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('declares the icu capability on requests so the server sends raw ICU', async () => {
        const fetchMock = mockFetchOnce();
        configure();

        await LangsysAppAPI.getTranslations('es-es');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Langsys-Capabilities']).toBe('icu');
    });

    it('reads from the modern /translations endpoint with project_id + locale', async () => {
        const fetchMock = mockFetchOnce();
        configure();

        await LangsysAppAPI.getTranslations('es-es');

        const [url] = fetchMock.mock.calls[0] as [string];
        expect(url).toContain('/translations?');
        // Not the deprecated project-scoped route.
        expect(url).not.toContain('projects/proj-123/translations');
        expect(url).toContain('project_id=proj-123');
        expect(url).toContain('locale=es-es');
    });

    it('registers via the modern /translatable-items endpoint with the unified body', async () => {
        const fetchMock = mockFetchOnce();
        configure();

        await LangsysAppAPI.createTranslatableItems([{ type: 'phrase', phrase: 'Home', category: 'UI' }]);

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/translatable-items');
        // Not the deprecated tokens / content-blocks routes.
        expect(url).not.toContain('/tokens');
        expect(url).not.toContain('/content-blocks');
        const body = JSON.parse(init.body as string);
        expect(body.project_id).toBe('proj-123');
        expect(body.translatable_items[0]).toMatchObject({ type: 'phrase', phrase: 'Home', category: 'UI' });
    });
});
