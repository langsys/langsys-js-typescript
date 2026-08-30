import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LangsysApp } from '../src/langsys-app.js';

/**
 * OBS-1 — an unusable write capability is surfaced at least once.
 *
 * REG-1 makes this failure completely silent otherwise: no request, no error,
 * nothing in the catalog. The integrator believes they are connected and has
 * nothing to report — which is why it has to be above debug level, and why it
 * must NOT fire for a read key doing exactly what a read key should.
 */

type Auth = { key_type?: string; write_enabled?: boolean };

/** Reach the private notice; these tests are about the diagnostic, not init plumbing. */
function authorize(data: Auth) {
    (LangsysApp as unknown as { applyAuthorization(d: object, c: string): void }).applyAuthorization(data, 'test');
}

function resetLatch() {
    (LangsysApp as unknown as { lastCapabilityNotice: string | null }).lastCapabilityNotice = null;
}

let warn: ReturnType<typeof vi.spyOn>;
const said = () => warn.mock.calls.flat().map(String).join(' ');

beforeEach(() => {
    resetLatch();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    resetLatch();
});

describe('a key that should write but cannot', () => {
    it('warns once, above debug level, naming the key type and the remedy', () => {
        authorize({ key_type: 'ip_write', write_enabled: false });

        expect(said()).toContain('cannot write');
        expect(said()).toContain('ip_write');
        expect(said()).toContain('allow-listed');
    });

    it('does not repeat while the answer stays the same', () => {
        authorize({ key_type: 'ip_write', write_enabled: false });
        const first = warn.mock.calls.length;
        authorize({ key_type: 'ip_write', write_enabled: false });

        expect(warn.mock.calls.length).toBe(first);
    });

    it('speaks again when a re-authorization CHANGES the answer', () => {
        // A grant arriving, or an address moving off the allow-list. Silence
        // here would mean the one signal never fires for the session that
        // actually needs it.
        authorize({ key_type: 'ip_write', write_enabled: false });
        warn.mockClear();

        authorize({ key_type: 'ip_write', write_enabled: true });
        authorize({ key_type: 'ip_write', write_enabled: false });

        expect(said()).toContain('cannot write');
    });
});

describe('the cases that must stay silent', () => {
    it('says nothing for a read key, which is behaving correctly', () => {
        // The common case. Warning here is how this notice becomes the one
        // everyone silences — taking the ip_write case with it.
        authorize({ key_type: 'read', write_enabled: false });
        expect(said()).not.toContain('cannot write');
    });

    it('says nothing when the session CAN write', () => {
        authorize({ key_type: 'write', write_enabled: true });
        expect(said()).not.toContain('cannot write');
    });

    it('says nothing when the server does not speak the capability at all', () => {
        // Absent write_enabled takes the legacy-inference path; it has its own
        // warning and is not an OBS-1 case.
        authorize({ key_type: 'write' });
        expect(said()).not.toContain('cannot write');
    });
});
