import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SSR-3: the `server` strategy requires the origin server's address to be
 * allow-listed, and the spec says to "state it as a precondition in its own callout,
 * not a footnote". Violation is silent and total: no error, no request, nothing in
 * the catalog, no report.
 *
 * Artifact inspection with a positive control. The README documented the three
 * strategies and never mentioned the allow-list at all until this was written.
 */

const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
const LF = String.fromCharCode(10);

function section(heading: string): string {
    const start = README.indexOf(LF + '## ' + heading);
    if (start < 0) return '';
    const next = README.indexOf(LF + '## ', start + 1);
    return README.slice(start, next < 0 ? undefined : next);
}

describe('SSR-3: the server strategy precondition is stated in its own callout', () => {
    const ssr = section('Server-Side Rendering');

    it('positive control: the section exists and documents the strategies', () => {
        expect(ssr).toContain('ssrTokenStrategy');
        expect(ssr).toContain("`'server'`");
    });

    it('carries a callout, not a footnote, that names the precondition', () => {
        const callout = ssr.split(LF).filter((line) => line.startsWith('> ')).join(' ');
        expect(callout).toMatch(/^> \*\*Precondition/);
        expect(callout).toContain("`'server'`");
        expect(callout).toContain('allow-list');
        expect(callout).toContain('fails silently');
    });
});
