/**
 * Server messages (spec MSG family): the entry a server sends for a validation
 * error or system message, and how a client finds and renders it.
 *
 * An entry is `{ field?, code, message, template, params? }` and those key names
 * are fixed across every SDK. `template` is the source sentence a client looks
 * up, `params` fills its `{name}` markers, `message` is the template already
 * filled (and possibly already localised by the server), `code` is the slug an
 * app branches on, and `field` is a dotted path for a field failure. The body
 * around the entries is the app's own, so entries are found wherever they sit.
 *
 * Everything here is pure except `renderServerMessage`, which renders through
 * `t()`; that one is exported from the main entry only.
 */

/** One server message entry (MSG-1). */
export interface ServerMessage {
    field?: string;
    code: string;
    message: string;
    template: string;
    params?: Record<string, unknown>;
}

/** Where to look for entries in a body, when the default search is not wanted (MSG-1). */
export interface ResolveServerMessagesOptions {
    /** A dotted path to the node holding the entries (`errors`, `data.failures`). Narrows the search to it. */
    key?: string;
    /**
     * Maps an app's native failures to entries, for a body that carries no
     * entries at all. What it returns is filtered through the same entry check.
     */
    resolver?: (body: unknown) => unknown;
}

/** The category templates are registered and rendered under unless configured otherwise (MSG-6). */
export const DEFAULT_SERVER_MESSAGE_CATEGORY = 'Errors';

/**
 * The shared validation vocabulary (MSG-2), in the spec's order. `invalid` is the
 * code for a failure that arrived with text but no rule. A code is for logic —
 * highlight a field, retry — and never chooses which text to show.
 */
export const SERVER_MESSAGE_CODES = [
    'required',
    'invalid_type',
    'invalid_format',
    'invalid_option',
    'invalid_date',
    'not_found',
    'already_taken',
    'mismatch',
    'too_short',
    'too_long',
    'too_small',
    'too_large',
    'too_few',
    'too_many',
    'not_allowed',
    'already_member',
    'not_member',
    'already_owner',
    'expired',
    'not_available',
    'invalid',
] as const;

/**
 * A marker is a lowercase snake_case name in braces (MSG-3). `{Name}`, `{ min }`
 * and `{1x}` are not markers and are never filled. Byte-compatible with the
 * server's grammar: the server fills `message` from the template with it, and a
 * client that disagreed about what a marker is would fill a different sentence.
 */
const MARKER = /\{([a-z][a-z0-9_]*)\}/g;

/** How deep the entry search walks. Error bodies are shallow; the bound stops a cyclic or pathological body. */
const MAX_DEPTH = 16;

/** The marker names in a template, once each, in the order they first appear. */
export function templateMarkers(template: string): string[] {
    if (typeof template !== 'string' || template === '') return [];
    const names: string[] = [];
    for (const match of template.matchAll(MARKER)) {
        if (!names.includes(match[1]!)) names.push(match[1]!);
    }
    return names;
}

/**
 * Fill a template's markers from params (MSG-4). A marker with no param stays
 * as its literal marker rather than going blank, so a missing value is visible
 * instead of producing a sentence that reads as complete. A structure is never
 * printed into the sentence; its marker stays too.
 */
export function fillTemplate(template: string, params: Record<string, unknown> = {}): string {
    return String(template).replace(MARKER, (marker, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(params, name)) return marker;
        const value = params[name];
        // `typeof null` is 'object', so null keeps its marker here too.
        if (value === undefined || typeof value === 'object' || typeof value === 'function') return marker;
        return String(value);
    });
}

/**
 * An entry from its wire form, or null when it is not one. `code`, `message`
 * and `template` must be strings. Without `template` there is nothing to look
 * up, and rendering from `message` as a key is the one thing a client must
 * never do (MSG-5), so such an object is not an entry.
 */
export function toServerMessage(value: unknown): ServerMessage | null {
    if (!isRecord(value)) return null;
    const { code, message, template, params, field } = value;
    if (typeof code !== 'string' || typeof message !== 'string' || typeof template !== 'string') return null;

    // Built in the wire's key order: field, code, message, template, params.
    return {
        ...(typeof field === 'string' && field !== '' ? { field } : {}),
        code,
        message,
        template,
        ...(isRecord(params) ? { params } : {}),
    };
}

/**
 * Every entry a response carries, wherever it sits (MSG-1).
 *
 * By default the whole body is searched and every object carrying an entry's
 * pieces is an entry, so the langsys envelope (`error`, `error.errors[]`), a
 * Laravel map, a JSON:API `errors[]` or a house style all resolve with nothing
 * configured. An entry's own `params` are never searched: they are marker
 * values, not more entries. `key` narrows the search to one dotted path;
 * `resolver` replaces it, for a body whose failures are not entries yet.
 *
 * Accepts the decoded body or its JSON text. Anything unreadable resolves to no
 * entries rather than throwing: this runs in an error path already.
 */
export function resolveServerMessages(body: unknown, options: ResolveServerMessagesOptions = {}): ServerMessage[] {
    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            return [];
        }
    }

    if (typeof options.resolver === 'function') {
        const mapped = options.resolver(body);
        const items = Array.isArray(mapped) ? mapped : mapped === undefined || mapped === null ? [] : [mapped];
        return items.map(toServerMessage).filter((entry): entry is ServerMessage => entry !== null);
    }

    if (typeof options.key === 'string' && options.key !== '') {
        body = dig(body, options.key);
    }

    const found: ServerMessage[] = [];
    walk(body, found, 0, new Set());
    return found;
}

function walk(node: unknown, found: ServerMessage[], depth: number, seen: Set<object>): void {
    if (depth > MAX_DEPTH || typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);

    const entry = Array.isArray(node) ? null : toServerMessage(node);
    if (entry) found.push(entry);

    for (const [key, child] of Object.entries(node)) {
        if (entry && key === 'params') continue;
        walk(child, found, depth + 1, seen);
    }
}

function dig(body: unknown, path: string): unknown {
    let node = body;
    for (const segment of path.split('.')) {
        if (typeof node !== 'object' || node === null || !Object.prototype.hasOwnProperty.call(node, segment)) {
            return undefined;
        }
        node = (node as Record<string, unknown>)[segment];
    }
    return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
