import { canonicalizeLocale } from './locale.js';
import { createSignal } from './signal.js';
import type { HttpResponse, ResponseObject } from './types/api.js';
import type { iLangsysConfig } from './types/config.js';
import { logger } from './logger.js';

type Method = 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT';

export interface SendOptions {
    /**
     * Let the request outlive the page that started it (`fetch` keepalive).
     * Used for the teardown flush, where the document is being torn down and a
     * normal request would be cancelled with it.
     *
     * NOT `navigator.sendBeacon`, which is the usual answer to this problem but
     * cannot carry custom headers — our authorization is `x-Authorization`, so
     * a beacon would be rejected. `keepalive` supports headers and survives
     * teardown; the trade is a ~64KB body cap across in-flight keepalive
     * requests, which is why the teardown path chunks conservatively.
     */
    keepalive?: boolean;
}

class LangsysAppAPIClass {
    private apiurl = 'https://api.langsys.dev/api';
    public config: iLangsysConfig;

    constructor() {
        this.config = {
            projectid: '',
            key: '',
            sUserLocale: createSignal(''),
            baseLocale: 'en',
        };
    }

    public setup(config: iLangsysConfig) {
        if (config?.key && config?.projectid) {
            this.config = config;
        }
    }

    /** True when a write grant is configured (in either form). */
    public hasWriteGrant(): boolean {
        return !!this.config.writeGrant;
    }

    /**
     * Resolve the current write grant, calling the consumer's provider if that
     * is the configured form.
     *
     * The result is deliberately NOT cached — not here, not on the config
     * singleton. Grants are ~5 minute JWTs and per-user, while this client is
     * a process-wide singleton; in a long-lived SSR server one cached token
     * would be attached to every later user's requests. Resolving per request
     * is also what lets the host app refresh by simply returning a new token.
     */
    private async resolveWriteGrant(): Promise<string | null> {
        const grant = this.config.writeGrant;
        if (!grant) return null;
        try {
            const token = typeof grant === 'function' ? await grant() : grant;
            return typeof token === 'string' && token.length > 0 ? token : null;
        } catch (err) {
            // A throwing provider must not take the request down with it —
            // the session simply proceeds without a grant (read-only).
            logger.warn('LangsysAppAPI: writeGrant provider threw; sending request without a grant', err);
            return null;
        }
    }

    /** Build request headers fresh per call. Never memoized — see `resolveWriteGrant`. */
    private async buildHeaders(): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json; charset=utf-8',
            'x-Authorization': this.config.key,
            // Declare ICU MessageFormat rendering so the server sends raw ICU
            // (plural/select) instead of flat-template downgrades. Pre-ICU
            // builds omit this header and keep receiving flat strings.
            'X-Langsys-Capabilities': 'icu',
        };

        // Sent on every request, not just writes: the grant is what the server
        // uses to compute `write_enabled`, which comes back on
        // `authorize-project` and on every catalog fetch.
        const grant = await this.resolveWriteGrant();
        if (grant) headers['X-Write-Grant'] = grant;

        return headers;
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
        // The CLDR-compliant backend keys catalogs by canonical BCP 47 tags.
        return await this.get('translations', { project_id: this.config.projectid, locale: canonicalizeLocale(locale) });
    }

    /**
     * Register phrases and/or content blocks via the current unified endpoint.
     * Each item carries `type: 'phrase' | 'content_block'`. Replaces the
     * deprecated `projects/{id}/tokens` and `projects/{id}/content-blocks` routes.
     */
    public async createTranslatableItems(items: Array<Record<string, unknown>>, opts: SendOptions = {}) {
        return await this.post(
            'translatable-items',
            {
                project_id: this.config.projectid,
                translatable_items: items,
            },
            opts,
        );
    }

    /**
     * Report that a page appears to contain unregistered content, so the
     * discovery renderer can visit it from an allow-listed IP and register
     * what it finds.
     *
     * URL only — never a phrase payload. This is the read-only lane: anonymous
     * callers can say "look here", never "store this". Answers 204 whether or
     * not the hint is acted on, deliberately so it can't be used as an oracle
     * for key validity or registration state. No `project_id`: the key already
     * resolves to exactly one project server-side.
     */
    public async postDiscoveryHint(pageUrl: string) {
        return await this.post('discovery/hint', { page_url: pageUrl });
    }

    public async post(path: string, data: Record<string, unknown> = {}, opts: SendOptions = {}) {
        return await this.send('POST', path, data, opts);
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

    private async send(
        method: Method,
        path: string,
        data: Record<string, unknown> = {},
        opts: SendOptions = {},
    ): Promise<ResponseObject> {
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
                headers: await this.buildHeaders(),
                method,
                body: method === 'GET' ? undefined : JSON.stringify(data),
                keepalive: opts.keepalive || undefined,
            });

            // 204 is a real success shape here — `discovery/hint` always answers
            // 204 with a genuinely empty body and no content-type header at all,
            // so parse on status rather than sniffing for JSON. An unconditional
            // .json() would throw on it.
            const responseData: ResponseObject =
                query.status === 204 || query.headers.get('content-length') === '0'
                    ? { status: query.ok }
                    : ((await query.json()) as ResponseObject);
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
