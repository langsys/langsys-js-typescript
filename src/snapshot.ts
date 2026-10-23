/**
 * Catalog snapshots (spec SNAP family): one file format every Langsys SDK
 * writes and reads, so a snapshot exported by any core loads in any other.
 *
 * A snapshot is the flat catalog (`GET /translations`) for chosen locales and
 * categories, carried as a file so a first render, a mobile bundle or an
 * offline session has translations with no network call. It is a cache, never
 * a source: Langsys produces it, a checksum over its canonical serialisation
 * catches an edited one, and the refresh path is a new export.
 *
 * Everything here is pure. Seeding a loaded snapshot into the SDK is
 * `LangsysApp.loadSnapshot`, on the main entry.
 */

/** The `format` member every snapshot carries. */
export const SNAPSHOT_FORMAT = 'langsys-catalog-snapshot';

/** The only `version` this SDK reads and writes. */
export const SNAPSHOT_VERSION = 1;

/** A category's flat entries as `GET /translations` returns them: phrase → translation or null, or a block id → its phrase map. */
export type SnapshotCategory = Record<string, string | null | Record<string, string | null>>;

/** locale → category → entries. A category the locale does not hold is absent; one it holds empty is `{}`. */
export type SnapshotCatalog = Record<string, Record<string, SnapshotCategory>>;

/** The members the checksum covers. */
export interface SnapshotPayload {
    project_id: string;
    /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
    generated_at: string;
    base_locale: string;
    /** Lowercase `xx-yy`, sorted ascending. */
    locales: string[];
    /** Sorted ascending. */
    categories: string[];
    catalog: SnapshotCatalog;
}

/** A whole snapshot document. */
export interface CatalogSnapshot extends SnapshotPayload {
    format: typeof SNAPSHOT_FORMAT;
    version: typeof SNAPSHOT_VERSION;
    /** `sha256:` and the lowercase hex digest of the canonical serialisation of the payload. */
    checksum: string;
}

/** Why a snapshot was refused. */
export type SnapshotRefusal = 'not-json' | 'format' | 'version' | 'missing-member' | 'checksum';

/** Thrown when a snapshot cannot be loaded. `reason` names why; the message says what to do. */
export class SnapshotError extends Error {
    constructor(
        message: string,
        readonly reason: SnapshotRefusal
    ) {
        super(message);
        this.name = 'SnapshotError';
    }
}

const PAYLOAD_MEMBERS = ['project_id', 'generated_at', 'base_locale', 'locales', 'categories', 'catalog'] as const;

/**
 * The canonical serialisation the checksum is taken over, byte for byte the
 * same in every SDK:
 *
 * - strings escaped as CID-1 serialises them — `"`, `\` and U+0000–U+001F only,
 *   everything else (`/`, non-ASCII, U+2028) raw — which is `JSON.stringify`'s
 *   own string escaping;
 * - no whitespace;
 * - object members sorted by key in Unicode code point order. Neither
 *   `Object.keys` order (integer-like keys first) nor the default `sort()`
 *   (UTF-16 code units, which puts a key above U+FFFF before one in
 *   U+E000–U+FFFF) is that order, so both are avoided;
 * - a map is `{}` even when empty; `null` is `null`.
 */
export function canonicalSnapshotJson(value: unknown): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalSnapshotJson).join(',')}]`;
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodePoints);
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalSnapshotJson(record[key])}`).join(',')}}`;
    }
    throw new TypeError(`A snapshot cannot hold a ${typeof value}.`);
}

/** `sha256:` and the lowercase hex SHA-256 of the canonical serialisation of the payload members. */
export function snapshotChecksum(payload: SnapshotPayload): string {
    const hashed: Record<string, unknown> = {};
    for (const member of PAYLOAD_MEMBERS) hashed[member] = payload[member];
    return 'sha256:' + sha256Hex(canonicalSnapshotJson(hashed));
}

/**
 * Build a snapshot document from catalogs already fetched — the writing half,
 * for an export tool. `catalogs` is locale → the catalog `GET /translations`
 * returned; only the chosen categories are kept, and a category a locale does
 * not hold stays absent for that locale. Locales are lowercased; both lists are
 * sorted.
 */
export function buildSnapshot(options: {
    projectId: string;
    baseLocale: string;
    catalogs: Record<string, Record<string, SnapshotCategory>>;
    categories: string[];
    generatedAt?: Date;
}): CatalogSnapshot {
    const categories = [...new Set(options.categories.map(String))].sort(compareCodePoints);
    const catalog: SnapshotCatalog = {};
    for (const [locale, categoriesForLocale] of Object.entries(options.catalogs)) {
        const kept: Record<string, SnapshotCategory> = {};
        for (const category of categories) {
            if (Object.prototype.hasOwnProperty.call(categoriesForLocale, category)) kept[category] = categoriesForLocale[category]!;
        }
        catalog[locale.toLowerCase()] = kept;
    }
    const payload: SnapshotPayload = {
        project_id: String(options.projectId),
        generated_at: (options.generatedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        base_locale: options.baseLocale.toLowerCase(),
        locales: Object.keys(catalog).sort(compareCodePoints),
        categories,
        catalog,
    };
    return { format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION, ...payload, checksum: snapshotChecksum(payload) };
}

/**
 * Read a snapshot from its JSON text or parsed document, refusing — with an
 * error naming the reason — a different `format`, an unsupported `version`, a
 * missing member, or a checksum the contents no longer match. The file may be
 * any JSON encoding of the document; the checksum is recomputed from the
 * canonical serialisation, never compared against the file's bytes.
 */
export function parseSnapshot(input: string | unknown): CatalogSnapshot {
    let document: unknown = input;
    if (typeof input === 'string') {
        try {
            document = JSON.parse(input);
        } catch {
            throw new SnapshotError('This is not a Langsys catalog snapshot: it is not JSON.', 'not-json');
        }
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        throw new SnapshotError('This is not a Langsys catalog snapshot: it is not a JSON object.', 'not-json');
    }
    const doc = document as Record<string, unknown>;

    if (doc.format !== SNAPSHOT_FORMAT) {
        throw new SnapshotError(`This is not a Langsys catalog snapshot: its format is ${JSON.stringify(doc.format)}, not "${SNAPSHOT_FORMAT}".`, 'format');
    }
    if (doc.version !== SNAPSHOT_VERSION) {
        throw new SnapshotError(`This snapshot is version ${JSON.stringify(doc.version)}; this SDK reads version ${SNAPSHOT_VERSION}. Export it again.`, 'version');
    }
    for (const member of [...PAYLOAD_MEMBERS, 'checksum']) {
        if (!Object.prototype.hasOwnProperty.call(doc, member)) {
            throw new SnapshotError(`This snapshot has no "${member}". Export it again.`, 'missing-member');
        }
    }
    if (doc.checksum !== snapshotChecksum(doc as unknown as SnapshotPayload)) {
        throw new SnapshotError(
            'This snapshot was changed after it was exported: its checksum does not match. A snapshot is a cache and is never edited; export it again.',
            'checksum'
        );
    }
    return doc as unknown as CatalogSnapshot;
}

/** Compare two strings by Unicode code point, which is UTF-8 byte order. */
function compareCodePoints(a: string, b: string): number {
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
        const ca = ia.next();
        const cb = ib.next();
        if (ca.done || cb.done) return ca.done && cb.done ? 0 : ca.done ? -1 : 1;
        const diff = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
        if (diff !== 0) return diff;
    }
}

/**
 * SHA-256 of a string's UTF-8 bytes, synchronously. Loading a snapshot is
 * synchronous by contract (SNAP-2) and the platform's digest is async, so the
 * hash is computed here — FIPS 180-4, no dependency.
 */
export function sha256Hex(text: string): string {
    const bytes = new TextEncoder().encode(text);
    const length = bytes.length;
    const blocks = Math.ceil((length + 9) / 64);
    const words = new Uint32Array(blocks * 16);
    for (let i = 0; i < length; i++) words[i >> 2]! |= bytes[i]! << (24 - (i % 4) * 8);
    words[length >> 2]! |= 0x80 << (24 - (length % 4) * 8);
    // The bit length, as a 64-bit big-endian integer in the last two words.
    words[words.length - 2] = Math.floor((length * 8) / 0x100000000);
    words[words.length - 1] = (length * 8) >>> 0;

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let block = 0; block < words.length; block += 16) {
        for (let t = 0; t < 16; t++) w[t] = words[block + t]!;
        for (let t = 16; t < 64; t++) {
            const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
            const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
            w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
        for (let t = 0; t < 64; t++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) >>> 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0]! + a) >>> 0;
        h[1] = (h[1]! + b) >>> 0;
        h[2] = (h[2]! + c) >>> 0;
        h[3] = (h[3]! + d) >>> 0;
        h[4] = (h[4]! + e) >>> 0;
        h[5] = (h[5]! + f) >>> 0;
        h[6] = (h[6]! + g) >>> 0;
        h[7] = (h[7]! + hh) >>> 0;
    }
    return Array.from(h, (word) => word.toString(16).padStart(8, '0')).join('');
}

function rotr(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
