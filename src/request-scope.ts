import { LangsysAppAPI } from './api.js';
import type { RegistrationResult } from './content-block.js';
import { LangsysApp } from './langsys-app.js';
import { canonicalizeLocale } from './locale.js';
import { activeScope, enterScope, runInScope, type ActiveScope } from './scope-context.js';
import { batchLimit, config as configStore } from './stores.js';
import { AUTO_SSR_FLUSH_THRESHOLD, type CatalogView } from './translations.js';
import type { RequestSeed, SeededBlock } from './block-tree.js';
import type { iContentBlock } from './types/content-block.js';
import type { TFunction } from './types/translation-fn.js';
import type { iCategories, iTranslations } from './types/translations.js';

/**
 * Request scopes (spec SRV-7): rendering on a server without one visitor's
 * state reaching the next.
 *
 * The core keeps one catalog, one locale and one miss queue in module state,
 * which is right for a page and wrong for a server process rendering for many
 * visitors at once. A scope holds its own: its locale, its view of the catalog,
 * the misses its render records, and the seed its page hands the client. A
 * binding opens one in its framework's request hook, renders inside `run()`,
 * serialises `seed()` into the page, and calls `close()` after the response.
 *
 * A catalog is fetched at most once per request, and shared read-only (frozen)
 * with scopes rendering the same locale within a minute, so a busy locale costs
 * one fetch rather than one per visitor. Nothing a scope writes is visible to
 * another scope or to the page.
 */

export interface RequestScopeOptions {
    /** The request's locale, as the framework or SRV-6 resolved it. */
    locale: string;
    /** A catalog already in hand (a snapshot, an upstream fetch); otherwise it is fetched. */
    catalog?: iCategories;
    /** The page's URL, for the records this scope keeps. */
    url?: string;
}

/** A phrase a scope's render missed. */
export interface ScopeMiss {
    category: string;
    phrase: string;
}

export interface RequestScope {
    readonly locale: string;
    /** `t()` over this scope's catalog; its misses are this scope's. */
    readonly t: TFunction;
    /**
     * Run `fn` inside the scope: top-level `t()`, `LangsysApp.t`, `tSignal.get()`,
     * and the lookups and registrations `Translate` and `Phrase` make, resolve to
     * it. Across `await` only once `setRequestScopeStorage` has an
     * `AsyncLocalStorage`; otherwise only code that finishes inside `fn`.
     */
    run<R>(fn: () => R): R;
    /**
     * Make the scope current for the rest of the current async context, where the
     * render cannot be wrapped in `run()`. Requires `setRequestScopeStorage` to
     * have been given an `AsyncLocalStorage`; throws otherwise.
     *
     * It holds only in the continuation that itself performs the render: called
     * inside a function the host awaits and returns from (a Nuxt plugin, a Nitro
     * request hook, an awaited helper), the scope is gone when that function
     * returns, before or after its own `await` alike. So call `enter()` in the
     * function that renders, `run()` everywhere else, and hand the scope to the
     * app through the framework's own injection when the host awaits you.
     */
    enter(): void;
    /**
     * The hydration seed (SRV-4): on the client, `LangsysApp.seedCatalog(seed.catalog,
     * seed.locale, seed)` before hydration. `blocks` names every block the scope
     * rendered through `renderBlock`, by id, with its category, source tokens and
     * shape, for a client that cannot recover a block's source from DOM already
     * holding the translation; hand each to `registerBlock` after `init()`.
     * `phrases` lists the phrases the render missed. A block or phrase the scope
     * sends itself at `close()` is marked `collected`, and the client never
     * registers it.
     */
    seed(): RequestSeed;
    /** The phrases this scope's render missed. */
    misses(): readonly ScopeMiss[];
    /**
     * After the response (SRV-3): send what the render missed, when this
     * process's session may write and the SSR strategy collects on the server,
     * then stop recording. Resolves what happened; never throws. Calling it
     * again resolves the first result.
     */
    close(): Promise<RegistrationResult>;
}

const SHARE_MS = 60_000;
const shared = new Map<string, { at: number; catalog: Promise<iCategories | null> }>();

/**
 * Open a request scope. Resolves once its catalog is in hand: the one passed,
 * one fetched within the last minute for the same project and locale, or a
 * fresh fetch. A fetch that fails leaves the scope rendering source text and
 * recording nothing, as the page does while its catalog is unavailable
 * (WIRE-4).
 */
export async function createRequestScope(options: RequestScopeOptions): Promise<RequestScope> {
    const locale = canonicalizeLocale(options.locale);
    const catalog = options.catalog ? freeze(normalizeCatalog(clone(options.catalog))) : await sharedCatalog(locale);
    return new Scope(locale, catalog ?? freeze(normalizeCatalog({} as iCategories)), catalog !== null);
}

/** The request scope the current code runs in, if any. */
export function currentRequestScope(): RequestScope | undefined {
    const scope = activeScope();
    return scope instanceof Scope ? scope : undefined;
}

/** Forget every shared catalog, so the next scope for each locale fetches afresh. */
export function clearSharedCatalogs(): void {
    shared.clear();
}

class Scope implements RequestScope, ActiveScope {
    private readonly phraseMisses = new Map<string, ScopeMiss>();
    private readonly blockMisses = new Map<string, iContentBlock>();
    private readonly rendered = new Map<string, SeededBlock>();
    private closing: Promise<RegistrationResult> | null = null;

    private readonly view: CatalogView = {
        catalog: () => this.catalog,
        locale: () => this.locale,
        miss: (category, key) => {
            if (!this.available || this.closing) return;
            this.phraseMisses.set(`${category}\0${key}`, { category, phrase: key });
        },
        fromSnapshot: () => false,
    };

    readonly t: TFunction = ((phrase: string, ...rest: unknown[]) =>
        LangsysApp.Translations.renderWith(this.view, phrase, rest)) as TFunction;

    constructor(
        readonly locale: string,
        readonly catalog: iCategories,
        private readonly available: boolean
    ) {}

    run<R>(fn: () => R): R {
        return runInScope(this, fn);
    }

    enter(): void {
        enterScope(this);
    }

    seed(): RequestSeed {
        // A block this scope will send itself at `close()` is marked `collected`, so the
        // client never sends it again (SSR-1, SSR-2): the decision `flush` makes, taken now.
        const collects = this.serverCollects(this.phraseMisses.size + this.blockMisses.size) && LangsysApp.Translations.mayWrite();
        const blocks: Record<string, SeededBlock> = {};
        for (const [id, block] of this.rendered) {
            const held =
                block.shape === 'phrase'
                    ? this.phraseMisses.has(`${block.category}\0${block.tokens[0]}`)
                    : this.blockMisses.has(`${block.category}\0${id}`);
            blocks[id] = collects && held ? { ...block, collected: true } : { ...block };
        }
        const phrases = [...this.phraseMisses.values()].map(({ category, phrase }) => (collects ? { category, phrase, collected: true } : { category, phrase }));
        return { locale: this.locale, catalog: clone(this.catalog), blocks: clone(blocks), phrases };
    }

    /** SSR-1 and SSR-2: whether the server sends a scope's misses, for a list this long. */
    private serverCollects(count: number): boolean {
        const strategy = configStore.ssrTokenStrategy || 'client';
        if (LangsysAppAPI.hasWriteGrant()) return false;
        return strategy === 'server' || (strategy === 'auto' && count < AUTO_SSR_FLUSH_THRESHOLD);
    }

    recordRendered(block: SeededBlock): void {
        this.rendered.set(block.customId, block);
    }

    misses(): readonly ScopeMiss[] {
        return [...this.phraseMisses.values()];
    }

    recordBlock(block: iContentBlock): void {
        if (!this.available || this.closing) return;
        this.blockMisses.set(`${block.category}\0${block.custom_id}`, block);
    }

    close(): Promise<RegistrationResult> {
        this.closing ??= this.flush();
        return this.closing;
    }

    private async flush(): Promise<RegistrationResult> {
        const items: Array<Record<string, unknown>> = [
            ...[...this.phraseMisses.values()].map((m) => ({ type: 'phrase', phrase: m.phrase, category: m.category || null })),
            ...[...this.blockMisses.values()].map((b) => ({
                type: 'content_block',
                custom_id: b.custom_id,
                category: b.category || null,
                content: b.content,
                label: b.label,
                phrases: b.tokens.map((phrase) => ({ phrase })),
            })),
        ];
        if (items.length === 0) return { status: true };

        // SSR-1 and SSR-2: the server collects only under the `server` strategy, or `auto`
        // for a short list, and never when a grant makes capability per-user. Otherwise the
        // client registers these misses itself after hydration.
        if (!this.serverCollects(items.length)) return { status: false, skipped: true, reason: 'client-strategy' };
        // SRV-3: a read-only key pushes nothing.
        if (!LangsysApp.Translations.mayWrite()) return { status: false, skipped: true, reason: 'not-write-enabled' };

        try {
            const size = batchLimit.get();
            for (let offset = 0; offset < items.length; offset += size) {
                const response = await LangsysAppAPI.createTranslatableItems(items.slice(offset, offset + size));
                if (!response.status) return { status: false, reason: 'refused', errors: response.errors as unknown[] | undefined };
            }
            return { status: true };
        } catch (err) {
            return { status: false, reason: 'failed', errors: [err] };
        }
    }
}

/** The catalog for a locale: shared within the minute if another scope fetched it, else fetched once. */
function sharedCatalog(locale: string): Promise<iCategories | null> {
    const key = `${configStore.projectid}:${locale}`;
    const hit = shared.get(key);
    if (hit && Date.now() - hit.at < SHARE_MS) return hit.catalog;
    const catalog = fetchCatalog(locale).then((result) => {
        // A failure is not shared: the next scope tries again.
        if (result === null) shared.delete(key);
        return result;
    });
    shared.set(key, { at: Date.now(), catalog });
    return catalog;
}

async function fetchCatalog(locale: string): Promise<iCategories | null> {
    try {
        const response = await LangsysAppAPI.getTranslations(locale);
        // The process's write capability, as the page's fetch records it.
        LangsysApp.Translations.applyWriteEnabled(response.write_enabled);
        if (response.errors) return null;
        return freeze(normalizeCatalog((isRecord(response.data) ? response.data : {}) as iCategories));
    } catch {
        return null;
    }
}

/** The catalog shape the page publishes: an `__uncategorized__` bucket, every category stamped, nothing else. */
function normalizeCatalog(catalog: iCategories): iCategories {
    for (const category of Object.keys(catalog)) {
        if (!isRecord(catalog[category])) delete catalog[category];
        else catalog[category]!.__category__ = category;
    }
    if (!isRecord(catalog.__uncategorized__)) {
        catalog.__uncategorized__ = { __category__: '__uncategorized__', __symbol__: '__uncategorized__' } as iTranslations;
    }
    return catalog;
}

function freeze<T>(value: T): T {
    if (isRecord(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
