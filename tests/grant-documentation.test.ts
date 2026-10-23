import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GRANT-1: `writeGrant` accepts a provider callback, documented as the default form.
 *
 * The acceptance half is behaviour and is covered in `grant-lane`. This is the
 * documentation half, checked on the SHIPPED type declarations, since the docs a
 * consumer reads in their editor are the ones in `dist/index.d.ts`, not the source
 * comment. A missing dist fails loudly rather than skipping; `npm test` builds first.
 */

function shippedTypes(): string {
    try {
        return readFileSync(join(process.cwd(), 'dist', 'index.d.ts'), 'utf8');
    } catch {
        throw new Error('dist/index.d.ts is missing: run `npm run build` first. This checks the shipped declarations.');
    }
}

describe('GRANT-1: the provider callback is documented as the default form', () => {
    const dts = shippedTypes();

    it('positive control: the declarations carry the writeGrant option being documented', () => {
        expect(dts).toMatch(/writeGrant\?: WriteGrant/);
    });

    it('says to prefer the function form', () => {
        expect(dts).toContain('Prefer the FUNCTION form');
    });

    it('and says the bare string is for quickstarts only', () => {
        expect(dts).toContain('the bare string is quickstart-only');
    });
});
