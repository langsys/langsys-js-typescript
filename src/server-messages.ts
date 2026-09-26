/**
 * Server messages (spec MSG family): the entries a server attaches to its
 * framework's own error response, and how a client finds and renders them.
 *
 * What translation needs is small: the `template` — the framework's own
 * sentence, unfilled, with the field's label written in — and the `params`
 * that fill its `{name}` markers. `message` is the template already filled, the
 * fallback a client shows when it cannot look the template up. Everything else
 * is the framework's and passes through unchanged: `field` in the framework's
 * own path format (a dotted string, Pydantic's `loc` array), and `code`, the
 * framework's own identifier for the failure (Laravel's rule name, Pydantic's
 * error `type`, Django's `code`), or none. The error body is the framework's
 * too, so where the entries sit and what their pieces are called are the
 * app's configuration.
 *
 * Everything here is pure except `renderServerMessage`, which renders through
 * `t()`; that one is exported from the main entry only.
 */

/** One server message entry (MSG-1), in the SDK's own piece names. */
export interface ServerMessage {
    template?: string;
    params?: Record<string, unknown>;
    message?: string;
    /** The field, in the framework's own path format, unchanged. */
    field?: unknown;
    /** The framework's own identifier for the failure, unchanged. Absent where the framework has none. */
    code?: unknown;
}

/** The piece names an app's entries use, where they differ from the SDK's. */
export type ServerMessagePieces = Partial<Record<'template' | 'params' | 'message' | 'field' | 'code', string>>;

/** Where the entries sit in a response body (MSG-1). One of `key` or `resolver` is required. */
export interface ResolveServerMessagesOptions {
    /**
     * The dotted path the server attached the entries under, beside the
     * framework's own error body — Laravel's package default is `langsys_errors`.
     */
    key?: string;
    /** Maps a body to entries itself, for an app whose failures are carried some other way. */
    resolver?: (body: unknown) => unknown;
    /** The entries' piece names, when the server was configured with names of its own. */
    pieces?: ServerMessagePieces;
}

/** The category templates are registered and rendered under unless configured otherwise (MSG-6). */
export const DEFAULT_SERVER_MESSAGE_CATEGORY = 'Errors';

/**
 * A marker is a lowercase snake_case name in braces (MSG-3). `{Name}`, `{ min }`
 * and `{1x}` are not markers and are never filled. Byte-compatible with the
 * server's grammar: the server fills `message` from the template with it, and a
 * client that disagreed about what a marker is would fill a different sentence.
 */
const MARKER = /\{([a-z][a-z0-9_]*)\}/g;

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
 * An entry from its wire form, or null when it is not one. An entry needs a
 * `template` to look up or a `message` to show; either is a string. `params`
 * is kept when it is an object; `field` and `code` pass through as they are.
 */
export function toServerMessage(value: unknown, pieces: ServerMessagePieces = {}): ServerMessage | null {
    if (!isRecord(value)) return null;
    const read = (piece: keyof ServerMessagePieces) => value[pieces[piece] ?? piece];
    const template = read('template');
    const message = read('message');
    const params = read('params');
    const field = read('field');
    const code = read('code');
    const hasTemplate = typeof template === 'string';
    const hasMessage = typeof message === 'string';
    if (!hasTemplate && !hasMessage) return null;

    return {
        ...(hasTemplate ? { template } : {}),
        ...(isRecord(params) ? { params } : {}),
        ...(hasMessage ? { message } : {}),
        ...(field !== undefined && field !== null && field !== '' ? { field } : {}),
        ...(code !== undefined && code !== null ? { code } : {}),
    };
}

/**
 * The entries a response carries, found where the app's configuration says
 * they are (MSG-1). The body is the framework's own and is never searched by
 * shape: `key` names the dotted path the server attached the entries under,
 * and `resolver` maps the body to entries itself. Throws when neither is given,
 * since there is nowhere to look. `pieces` renames the entries' pieces.
 *
 * Accepts the decoded body or its JSON text, and never changes the body.
 * Unreadable JSON, or a key the body does not carry, resolves to no entries:
 * this runs in an error path already.
 */
export function resolveServerMessages(body: unknown, options: ResolveServerMessagesOptions): ServerMessage[] {
    const { key, resolver, pieces } = options ?? {};
    if (typeof resolver !== 'function' && (typeof key !== 'string' || key === '')) {
        throw new TypeError(
            'resolveServerMessages needs to know where the entries sit: pass { key } with the path your server attaches them under (Laravel: "langsys_errors"), or { resolver }.'
        );
    }

    if (typeof body === 'string') {
        try {
            body = JSON.parse(body);
        } catch {
            return [];
        }
    }

    const found = typeof resolver === 'function' ? resolver(body) : dig(body, key!);
    return toItems(found)
        .map((item) => toServerMessage(item, pieces))
        .filter((entry): entry is ServerMessage => entry !== null);
}

/** A list of entries, a single entry, or a field → entries map, as items. */
function toItems(found: unknown): unknown[] {
    if (Array.isArray(found)) return found;
    if (!isRecord(found)) return [];
    const values = Object.values(found);
    return values.every((value) => Array.isArray(value)) && values.length > 0 ? values.flat() : [found];
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
