import { LangsysAppAPI } from './api.js';
import { interpolate } from './interpolate.js';
import { Logger } from './logger.js';
import { createSignal, type Signal } from './signal.js';
import { currentlyLoadedLocale, sTranslations } from './stores.js';
import type { ResponseObject } from './types/api.js';
import type { iLangsysConfig } from './types/config.js';
import type { ParamsFor, TArgs, TFunction } from './types/translation-fn.js';
import type { iCategories, iTranslations } from './types/translations.js';

interface iTokenUpdate {
    projectid: string;
    category: string;
    token: string;
}

function isObject(test: unknown): test is Record<string, unknown> {
    return typeof test === 'object' && !Array.isArray(test) && test !== null;
}
function sameToken(a: iTokenUpdate, b: iTokenUpdate): boolean {
    return a.projectid === b.projectid && a.category === b.category && a.token === b.token;
}

/**
 * Lifecycle for app translations:
 *  - on-miss: any `t(cat, phrase)` whose phrase isn't in the catalog is
 *    queued as a "missing token" and (with write keys) flushed to the API.
 *  - locale changes trigger `change()` which fetches and replaces.
 *  - consumers can `subscribe(fn)` to react to translation snapshots.
 *  - frameworks subscribe to `tSignal` (which re-emits a fresh `TFunction`
 *    every time translations or the loaded locale change) so reactive
 *    templates re-render automatically.
 */
export class Translations {
    private config: iLangsysConfig;
    private locale: string;
    private lastLoaded: Record<string, number> = {};
    private missingTokens: iTokenUpdate[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushScheduled = false;
    private isFirstClientRun = true;
    public debug: Logger;

    /** Reactive holder for the current translation function. Re-emits on every catalog/locale change. */
    public tSignal: Signal<TFunction>;

    constructor(config: iLangsysConfig) {
        this.config = config;
        this.debug = new Logger(!!config.debug);
        this.locale = config.baseLocale || '';

        this.tSignal = createSignal<TFunction>(this.buildTFn());
        sTranslations.subscribe(() => this.tSignal.set(this.buildTFn()));
        currentlyLoadedLocale.subscribe(() => this.tSignal.set(this.buildTFn()));

        if (config.key && config.projectid) this.setup(config);
    }

    /** Current translation function. Reads fresh state on every call. */
    public get t(): TFunction {
        return this.tSignal.get();
    }

    /** Subscribe to translation snapshot changes. Fires immediately with the current value. */
    public subscribe(run: (value: iCategories) => void) {
        return sTranslations.subscribe(run);
    }

    /**
     * Content-block-keyed lookup used by the DOM `Translate` class.
     * Returns the per-token translation inside a content block, or `null` if
     * either the content block or the inner token is missing. Never registers
     * a missing token — the DOM class manages its own lifecycle via content blocks.
     */
    public lookupContent(category: string, customId: string, token: string): string | null {
        const cats = sTranslations.get();
        const lookupCat = category || '__uncategorized__';
        const contentData = cats[lookupCat]?.[customId];
        if (!contentData || typeof contentData !== 'object') return null;
        const value = (contentData as unknown as Record<string, string>)[token];
        return typeof value === 'string' ? value : null;
    }

    private buildTFn(): TFunction {
        return <P extends string>(category: string, phrase: P, ...args: TArgs<P>): string => {
            const cats = sTranslations.get();
            const lookupCat = category || '__uncategorized__';
            const value = cats[lookupCat]?.[phrase];

            let translated: string;
            if (typeof value === 'string' && value.length > 0) {
                this.debug.log('TRANSLATION FOUND', [lookupCat, phrase, value]);
                translated = value;
            } else {
                this.missingToken(lookupCat, phrase);
                translated = phrase;
            }

            const params = args[0] as ParamsFor<P> | undefined;
            return params ? interpolate(translated, params as Record<string, unknown>) : translated;
        };
    }

    private missingToken(category: string, token: string | undefined | null) {
        if (token === undefined || token === null) {
            return this.debug.warn(`Received undefined or null token for category: ${category}`);
        }

        if (this.config.key_type !== 'write') {
            this.debug.log(`Skipping missing token collection (API key is ${this.config.key_type || 'unknown'}):`, {
                category,
                token,
            });
            return;
        }

        // Skip content-block id lookups (32-hex md5 strings).
        if (/^[0-9a-f]{32}$/.test(token)) return;
        if (token === 'toJSON') {
            this.debug.error(`Received toJSON as token ${category}:${token}`, token);
            return;
        }
        if (token === '') {
            this.debug.warn('Received empty token', token);
            return;
        }

        const missingToken: iTokenUpdate = { category, token, projectid: this.config.projectid };
        if (!this.missingTokens.some((t) => sameToken(t, missingToken))) {
            this.debug.log('MISSING TOKEN LOOKUP FAILED', [missingToken, [...this.missingTokens], { ...sTranslations.get() }]);
            this.missingTokens.push(missingToken);
            this.scheduleTokenFlush();
        }
    }

    private scheduleTokenFlush() {
        const strategy = this.config.ssrTokenStrategy || 'client';
        const isSSR = typeof window === 'undefined';

        if (isSSR) {
            switch (strategy) {
                case 'server':
                    if (!this.flushScheduled) {
                        this.flushScheduled = true;
                        queueMicrotask(() => {
                            this.updateTokens().then(() => {
                                this.flushScheduled = false;
                            });
                        });
                    }
                    break;

                case 'auto':
                    if (this.missingTokens.length <= 5 && !this.flushScheduled) {
                        this.flushScheduled = true;
                        queueMicrotask(() => {
                            this.updateTokens().then(() => {
                                this.flushScheduled = false;
                            });
                        });
                    }
                    break;

                case 'client':
                default:
                    this.debug.log('SSR: Queuing tokens for client-side transmission');
                    break;
            }
        } else {
            // Client — flush immediately on first discovery, then let the 3s timer take over.
            if (!this.flushScheduled && !this.timer) {
                this.flushScheduled = true;
                queueMicrotask(() => {
                    this.updateTokens().then(() => {
                        this.flushScheduled = false;
                    });
                });
            }
        }
    }

    public setup(config: iLangsysConfig) {
        this.config = config;
        if (!this.config.projectid || !this.config.key) return;

        if (this.config.debug) this.debug.debugEnabled = this.config.debug;
        if (config.baseLocale) this.locale = config.baseLocale;

        this.debug.log('TRANSLATION SETUP INITIATED', this.config);

        if (typeof window !== 'undefined') {
            if (this.isFirstClientRun && this.missingTokens.length > 0) {
                this.isFirstClientRun = false;
                const strategy = this.config.ssrTokenStrategy || 'client';
                if (strategy === 'client' || (strategy === 'auto' && this.missingTokens.length > 5)) {
                    this.debug.log(`Post-hydration: Flushing ${this.missingTokens.length} SSR-collected tokens`);
                    queueMicrotask(() => this.updateTokens());
                }
            }

            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => this.updateTokens(), 3000);
            this.debug.log('UPDATE TOKEN INTERVAL', this.timer);
        } else {
            const strategy = this.config.ssrTokenStrategy || 'client';
            this.debug.log(`SSR environment detected - using '${strategy}' token strategy`);
        }
    }

    /**
     * React to a user-locale change. Fetches translations if we haven't
     * loaded this locale within the last 60s (or if forced).
     */
    public async change(locale: string, force = false, skipFetch = false): Promise<boolean> {
        if (!locale) return false;
        if (!this.config.projectid || !this.config.key) return false;

        if (skipFetch) {
            this.debug.log('Using pre-fetched translations for locale', locale);
            this.locale = locale;
            this.lastLoaded[locale] = new Date().getTime() / 1000;
            return true;
        }

        const now = new Date().getTime() / 1000;
        if (
            !force &&
            locale === this.locale &&
            this.lastLoaded[locale] &&
            Math.abs(this.lastLoaded[locale] - now) < 60
        ) {
            return false;
        }

        this.debug.log('Locale change detected!', locale);
        this.locale = locale;
        await this.getTranslations();
        return true;
    }

    private async updateTokens(): Promise<boolean> {
        if (!this.missingTokens.length) return false;
        if (!this.config.projectid || !this.config.key) return false;
        if (this.config.key_type !== 'write') {
            this.debug.log(`Skipping token updates (API key is ${this.config.key_type || 'unknown'})`);
            return false;
        }

        if (typeof window === 'undefined') {
            this.debug.log(`Sending ${this.missingTokens.length} tokens from SSR`);
        }

        const currentData = sTranslations.get();
        this.missingTokens = this.missingTokens.filter((tokenObj) => {
            tokenObj.projectid = this.config.projectid;
            if (tokenObj.category in currentData && tokenObj.token in currentData[tokenObj.category]) {
                this.debug.log('Missing token already exists! Skipping:', {
                    category: tokenObj.category,
                    token: tokenObj.token,
                    existing: currentData[tokenObj.category][tokenObj.token],
                });
                return false;
            }
            return true;
        });

        if (!this.missingTokens.length) return false;

        this.debug.log('CREATE MISSING TOKENS', this.missingTokens);
        try {
            const response: ResponseObject = await LangsysAppAPI.post('projects/[projectid]/tokens', {
                tokens: this.missingTokens,
            });
            if (!response.status) {
                if (response.errors) {
                    this.debug.log('TOKEN UPDATE FAIL', this.missingTokens);
                    this.debug.error('Error updating project tokens', response.errors);
                }
                return false;
            }

            this.missingTokens.forEach((tokenObj) => {
                if (!currentData[tokenObj.category]) {
                    currentData[tokenObj.category] = {
                        __category__: tokenObj.category,
                        __symbol__: tokenObj.category,
                    } as iTranslations;
                }
                currentData[tokenObj.category][tokenObj.token] = tokenObj.token;
                currentData[tokenObj.category]['__category__'] = tokenObj.category;
            });
            sTranslations.set({ ...currentData });
            this.missingTokens = [];
            return true;
        } catch (err) {
            this.debug.log('CREATE MISSING TOKEN FAILURE', this.missingTokens);
            this.debug.error('Error updating project tokens', err);
            return false;
        }
    }

    private async getTranslations(): Promise<void> {
        if (!LangsysAppAPI.config.projectid && this.config.projectid) {
            LangsysAppAPI.setup(this.config);
        }

        const response: ResponseObject = await LangsysAppAPI.getTranslations(this.locale);
        this.debug.log('GET TRANSLATIONS API RESPONSE', response);
        if (response.errors) {
            this.debug.error('Error', response.errors[0]);
            return;
        }

        const trans = response.data as iCategories;

        if (!isObject(trans['__uncategorized__'])) {
            trans['__uncategorized__'] = {
                __category__: '__uncategorized__',
                __symbol__: '__uncategorized__',
            } as iTranslations;
        }

        for (const cat of Object.keys(trans)) {
            trans[cat]['__category__'] = cat;
        }

        this.debug.log('GET TRANSLATIONS ' + this.locale, trans);

        sTranslations.set(trans);
        // Small delay so consumers see translations + locale updates on the same tick.
        setTimeout(() => currentlyLoadedLocale.set(this.locale), 100);
        this.lastLoaded[this.locale] = new Date().getTime() / 1000;
    }
}

export default Translations;
