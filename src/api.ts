import { createSignal } from './signal.js';
import type { HttpResponse, ResponseObject } from './types/api.js';
import type { iLangsysConfig } from './types/config.js';
import { logger } from './logger.js';

type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

class LangsysAppAPIClass {
    private apiurl = 'https://api.langsys.dev/api';
    public config: iLangsysConfig;
    private headers: { 'Content-Type': string; 'x-Authorization': string; 'X-Langsys-Capabilities': string };

    constructor() {
        this.config = {
            projectid: '',
            key: '',
            sUserLocale: createSignal(''),
            baseLocale: 'en',
        };
        this.headers = {
            'Content-Type': 'application/json; charset=utf-8',
            'x-Authorization': this.config.key,
            // Declare ICU MessageFormat rendering so the server sends raw ICU
            // (plural/select) instead of flat-template downgrades. Pre-ICU
            // builds omit this header and keep receiving flat strings.
            'X-Langsys-Capabilities': 'icu',
        };
    }

    public setup(config: iLangsysConfig) {
        if (config?.key && config?.projectid) {
            this.config = config;
            this.headers['x-Authorization'] = this.config.key;
        }
    }

    /** Optional hook to point the client at a different API host. */
    public setBaseUrl(url: string) {
        this.apiurl = url.replace(/\/$/, '');
    }

    public async validate(config: iLangsysConfig) {
        this.setup(config);
        return await this.get('authorize-project/[projectid]');
    }

    public async getTranslations(locale: string) {
        return await this.get('translations', { project_id: this.config.projectid, locale });
    }

    /**
     * Register phrases and/or content blocks via the current unified endpoint.
     * Each item carries `type: 'phrase' | 'content_block'`. Replaces the
     * deprecated `projects/{id}/tokens` and `projects/{id}/content-blocks` routes.
     */
    public async createTranslatableItems(items: Array<Record<string, unknown>>) {
        return await this.post('translatable-items', {
            project_id: this.config.projectid,
            translatable_items: items,
        });
    }

    public async post(path: string, data: Record<string, unknown> = {}) {
        return await this.send('POST', path, data);
    }
    public async get(path: string, data: Record<string, unknown> = {}) {
        return await this.send('GET', path, data);
    }
    public async delete(path: string, data: Record<string, unknown> = {}) {
        return await this.send('DELETE', path, data);
    }
    public async patch(path: string, data: Record<string, unknown> = {}) {
        return await this.send('PATCH', path, data);
    }
    public async put(path: string, data: Record<string, unknown> = {}) {
        return await this.send('PUT', path, data);
    }

    private async send(method: Method, path: string, data: Record<string, unknown> = {}): Promise<ResponseObject> {
        if (!this.config.projectid || !this.config.key) {
            return {
                status: false,
                errors: ['Missing projectid or API key in configuration'],
                http: {
                    status: 0,
                    statusText: 'Configuration Error',
                    url: `${this.apiurl}/${path}`,
                    data: JSON.stringify(data),
                },
            };
        }

        // API calls should not include a leading slash.
        if (path.startsWith('/')) path = path.substring(1);

        // Replace [projectid] token with the actual configured projectid.
        if (path.includes('/[projectid]')) {
            path = path.replaceAll('/[projectid]', `/${this.config.projectid}`);
        }

        try {
            const querystring =
                method === 'GET'
                    ? '?' + new URLSearchParams(data as Record<string, string>).toString()
                    : '';

            const query = await fetch(`${this.apiurl}/${path}${querystring === '?' ? '' : querystring}`, {
                headers: this.headers,
                method,
                body: method === 'GET' ? undefined : JSON.stringify(data),
            });

            const responseData = (await query.json()) as ResponseObject;
            const http: HttpResponse = {
                status: query.status,
                statusText: query.statusText,
                url: query.url,
                data: JSON.stringify(data),
            };
            responseData.http = http;

            if (!query.ok) {
                logger.warn('LangsysAppAPI failed to query', responseData);
                return {
                    status: false,
                    errors: [`HTTP ${query.status}: ${query.statusText}`],
                    data: responseData,
                    http,
                };
            }

            return responseData;
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
            logger.error('LangsysAppAPI Error:', errorMessage);
            logger.error('Request details:', {
                method,
                url: `${this.apiurl}/${path}`,
                data,
            });
            return {
                status: false,
                errors: ['Error communicating with API Server', errorMessage],
                http: {
                    status: 0,
                    statusText: 'Network Error',
                    url: `${this.apiurl}/${path}`,
                    data: JSON.stringify(data),
                },
            };
        }
    }
}

export const LangsysAppAPI = new LangsysAppAPIClass();
export default LangsysAppAPI;
