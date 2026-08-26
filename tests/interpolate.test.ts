import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpolate, isICU } from '../src/interpolate.js';
import { logger } from '../src/logger.js';

describe('isICU', () => {
    it('detects plural', () => {
        expect(isICU('{n, plural, one {# review} other {# reviews}}')).toBe(true);
    });

    it('detects select (gender)', () => {
        expect(isICU('{g, select, male {él} female {ella} other {ellos}}')).toBe(true);
    });

    it('detects selectordinal, number, date, time', () => {
        expect(isICU('{n, selectordinal, one {1st} other {#th}}')).toBe(true);
        expect(isICU('{n, number, ::compact-short}')).toBe(true);
        expect(isICU('{d, date, short}')).toBe(true);
        expect(isICU('{t, time, short}')).toBe(true);
    });

    it('detects style-less ICU args ({n, number} with locale-default style)', () => {
        expect(isICU('{n, number}')).toBe(true);
        expect(isICU('{d, date}')).toBe(true);
        expect(isICU('{t, time}')).toBe(true);
    });

    it('does not detect simple interpolation', () => {
        expect(isICU('Hello, {name}!')).toBe(false);
        expect(isICU('{count} items in your cart')).toBe(false);
        expect(isICU('plain text with no slots')).toBe(false);
    });

    it('tolerates the ICU keyword appearing as text only', () => {
        // No comma after the keyword → not ICU shape.
        expect(isICU('something plural here {n}')).toBe(false);
    });

    it('detects ICU mixed with regular text', () => {
        expect(isICU('Hello {name}, {n, plural, one {1 alert} other {# alerts}}')).toBe(true);
    });
});

describe('interpolate — simple {name} path', () => {
    it('substitutes a single placeholder', () => {
        expect(interpolate('Hello, {name}!', { name: 'X' })).toBe('Hello, X!');
    });

    it('substitutes multiple placeholders', () => {
        expect(interpolate('Hi {first} {last}', { first: 'A', last: 'B' })).toBe('Hi A B');
    });

    it('leaves unknown placeholders untouched (visible to dev)', () => {
        expect(interpolate('Hello, {name}!', {})).toBe('Hello, {name}!');
    });

    it('leaves null/undefined values untouched', () => {
        expect(interpolate('Hello, {name}!', { name: null })).toBe('Hello, {name}!');
        expect(interpolate('Hello, {name}!', { name: undefined })).toBe('Hello, {name}!');
    });

    it('coerces booleans via String()', () => {
        expect(interpolate('On: {b}', { b: true })).toBe('On: true');
    });

    it('formats numbers with the target locale CLDR rules', () => {
        expect(interpolate('Count: {n}', { n: 42 })).toBe('Count: 42');
        expect(interpolate('Count: {n}', { n: 1234.5 }, 'en')).toBe('Count: 1,234.5');
        expect(interpolate('Count: {n}', { n: 1234.5 }, 'de-DE')).toBe('Count: 1.234,5');
    });

    it('leaves string-typed numeric params untouched (opt-out for IDs)', () => {
        expect(interpolate('Order {id}', { id: '12345' }, 'en')).toBe('Order 12345');
    });

    it('formats Date values per locale (medium date style)', () => {
        const d = new Date('2026-05-27T12:00:00.000Z');
        const expectedEn = new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(d);
        const expectedDe = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(d);
        expect(interpolate('When: {d}', { d }, 'en')).toBe(`When: ${expectedEn}`);
        expect(interpolate('When: {d}', { d }, 'de-DE')).toBe(`When: ${expectedDe}`);
    });

    it('trims keys with whitespace', () => {
        expect(interpolate('Hello, { name }!', { name: 'X' })).toBe('Hello, X!');
    });
});

describe('interpolate — ICU plural path', () => {
    it('renders en plural one/other correctly', () => {
        const tpl = '{n, plural, one {Based on # review} other {Based on # reviews}}';
        expect(interpolate(tpl, { n: 1 }, 'en')).toBe('Based on 1 review');
        expect(interpolate(tpl, { n: 5 }, 'en')).toBe('Based on 5 reviews');
        expect(interpolate(tpl, { n: 0 }, 'en')).toBe('Based on 0 reviews');
    });

    it('renders es-es plural one/other correctly', () => {
        const tpl = '{n, plural, one {Basado en # reseña} other {Basado en # reseñas}}';
        expect(interpolate(tpl, { n: 1 }, 'es-es')).toBe('Basado en 1 reseña');
        expect(interpolate(tpl, { n: 5 }, 'es-es')).toBe('Basado en 5 reseñas');
    });

    it('honors ar-sa six-category plural rules', () => {
        // Arabic distinguishes zero/one/two/few/many/other. Distinct branches:
        const tpl =
            '{n, plural, zero {zero-branch} one {one-branch} two {two-branch} few {few-branch} many {many-branch} other {other-branch}}';
        expect(interpolate(tpl, { n: 0 }, 'ar-sa')).toBe('zero-branch');
        expect(interpolate(tpl, { n: 1 }, 'ar-sa')).toBe('one-branch');
        expect(interpolate(tpl, { n: 2 }, 'ar-sa')).toBe('two-branch');
        // few: 3-10 are "few" in Arabic
        expect(interpolate(tpl, { n: 3 }, 'ar-sa')).toBe('few-branch');
        expect(interpolate(tpl, { n: 11 }, 'ar-sa')).toBe('many-branch');
    });

    it('falls back to other for missing categories', () => {
        const tpl = '{n, plural, other {fallback #}}';
        expect(interpolate(tpl, { n: 1 }, 'en')).toBe('fallback 1');
        expect(interpolate(tpl, { n: 100 }, 'en')).toBe('fallback 100');
    });
});

describe('interpolate — style-less ICU args', () => {
    it('formats {n, number} via the ICU path with locale-default style', () => {
        expect(interpolate('Total: {n, number}', { n: 1234.5 }, 'en')).toBe('Total: 1,234.5');
        expect(interpolate('Total: {n, number}', { n: 1234.5 }, 'de-DE')).toBe('Total: 1.234,5');
    });

    it('does not render {n, number} as a literal string', () => {
        expect(interpolate('Total: {n, number}', { n: 7 }, 'en')).not.toContain('{');
    });
});

describe('interpolate — ICU select (gender)', () => {
    it('selects the matching branch', () => {
        const tpl = '{g, select, male {Él} female {Ella} other {Elles}}';
        expect(interpolate(tpl, { g: 'male' }, 'es-es')).toBe('Él');
        expect(interpolate(tpl, { g: 'female' }, 'es-es')).toBe('Ella');
        expect(interpolate(tpl, { g: 'nonbinary' }, 'es-es')).toBe('Elles');
    });
});

describe('interpolate — mixed ICU + simple slots', () => {
    it('routes the whole template through ICU when ICU syntax is present', () => {
        // IntlMessageFormat handles {name} alongside ICU constructs natively.
        const tpl = 'Hello {name}, {n, plural, one {1 alert} other {# alerts}}';
        expect(interpolate(tpl, { name: 'Sarah', n: 1 }, 'en')).toBe('Hello Sarah, 1 alert');
        expect(interpolate(tpl, { name: 'Sarah', n: 5 }, 'en')).toBe('Hello Sarah, 5 alerts');
    });
});

describe('interpolate — malformed ICU fallback', () => {
    it('falls back to simple interpolation on parse failure (no throw)', () => {
        // Missing closing branch — IntlMessageFormat constructor throws.
        // Our fallback should silently route through simpleInterpolate so the
        // developer sees a broken-but-visible string rather than a runtime
        // crash. simpleInterpolate won't substitute `{n` (no closing brace)
        // so the original template is returned mostly intact.
        const malformed = '{n, plural, one {one #}';
        expect(() => interpolate(malformed, { n: 1 }, 'en')).not.toThrow();
    });

    it('does not consume ICU-shaped slots in fallback', () => {
        // simpleInterpolate's regex excludes `,` from key chars so malformed
        // ICU content doesn't get incorrectly substituted.
        const malformed = '{n, plural, one {one #}';
        const out = interpolate(malformed, { n: 1 }, 'en');
        expect(out).toBe(malformed);
    });
});

describe('interpolate — missing select arguments fall back to `other`', () => {
    // The ICU promoter in langsys-ai introduces a select argument the source
    // phrase never carried (`{name}` → `{name_gender, select, …}` in the
    // gendered target locales), so apps that don't know their user's gender
    // can't supply it. Those apps must get the neutral branch, not raw ICU.
    const welcome =
        '{name_gender, select, male {Bienvenido, {name}!} female {Bienvenida, {name}!} other {Te damos la bienvenida, {name}!}}';

    it('uses the supplied branch when the argument is present', () => {
        expect(interpolate(welcome, { name: 'Laura', name_gender: 'female' }, 'es')).toBe('Bienvenida, Laura!');
        expect(interpolate(welcome, { name: 'Diego', name_gender: 'male' }, 'es')).toBe('Bienvenido, Diego!');
    });

    it('falls back to `other` when the argument is absent', () => {
        expect(interpolate(welcome, { name: 'Laura' }, 'es')).toBe('Te damos la bienvenida, Laura!');
    });

    it('treats null and undefined as absent', () => {
        expect(interpolate(welcome, { name: 'Laura', name_gender: null }, 'es')).toBe('Te damos la bienvenida, Laura!');
        expect(interpolate(welcome, { name: 'Laura', name_gender: undefined }, 'es')).toBe(
            'Te damos la bienvenida, Laura!'
        );
    });

    it('routes an unrecognized value to `other` (ICU select semantics)', () => {
        expect(interpolate(welcome, { name: 'Laura', name_gender: 'nonbinary' }, 'es')).toBe(
            'Te damos la bienvenida, Laura!'
        );
    });

    it('fills only the missing argument when several selects are present', () => {
        const tpl = '{a_gender, select, female {Ella} other {Elle}} y {b_gender, select, female {ella} other {elle}}';
        expect(interpolate(tpl, { a_gender: 'female' }, 'es')).toBe('Ella y elle');
    });

    it('fills selects nested inside a plural branch', () => {
        const tpl = '{n, plural, one {{g, select, female {Una invitada} other {Un invitado}}} other {# invitados}}';
        expect(interpolate(tpl, { n: 1 }, 'es')).toBe('Un invitado');
        expect(interpolate(tpl, { n: 1, g: 'female' }, 'es')).toBe('Una invitada');
    });

    it('fills plurals nested inside a select branch', () => {
        const tpl =
            '{g, select, female {Ella tiene {n, plural, one {# mensaje} other {# mensajes}}} other {Tiene {n, plural, one {# mensaje} other {# mensajes}}}}';
        expect(interpolate(tpl, { n: 3 }, 'es')).toBe('Tiene 3 mensajes');
        expect(interpolate(tpl, { n: 3, g: 'female' }, 'es')).toBe('Ella tiene 3 mensajes');
    });

    it('leaves plural-only templates untouched (no select args to fill)', () => {
        const tpl = '{n, plural, one {# mensaje} other {# mensajes}}';
        expect(interpolate(tpl, { n: 1 }, 'es')).toBe('1 mensaje');
    });

    it('still recovers rather than throwing when a plural argument is missing', () => {
        const tpl = '{n, plural, one {# mensaje} other {# mensajes}}';
        expect(() => interpolate(tpl, {}, 'es')).not.toThrow();
    });
});

describe('interpolate — a recovered argument survives the format call', () => {
    // Cross-leg hole PHP hit live: if recovery rewrites the missing nodes but
    // the ORIGINAL params object still reaches the formatter, a
    // present-but-null argument gets substituted as an EMPTY STRING, erasing
    // the `{argName}` literal the rewrite just produced. Their fixture row went
    // from '{count} items' to ' items'.
    //
    // This leg is safe by a different mechanism than theirs, and the mechanism
    // is the thing worth pinning: recovery REPLACES the argument node with a
    // literal, so no node bearing that name survives for the formatter to
    // substitute. Nothing is withheld from `params` — there is simply nothing
    // left to bind. An implementation that instead left the node in place and
    // filtered `params` would pass every other test in this file.
    //
    // The discriminating vector is a null-VALUED argument. An absent one does
    // not expose it, which is why the control below sits next to it.
    it('does not erase a recovered plain argument whose value is null', () => {
        expect(interpolate('{name} has {count, plural, one {# item} other {# items}}', { name: null, count: 2 }, 'en')).toBe(
            '{name} has 2 items'
        );
    });

    it('does not erase a recovered plural count whose value is null', () => {
        expect(interpolate('{count, plural, one {# item} other {# items}}', { count: null }, 'en')).toBe('{count} items');
    });

    it('reaches a null argument nested inside a SUPPLIED select branch', () => {
        expect(interpolate('{g, select, female {Ella {n}} other {Elle {n}}}', { g: 'female', n: null }, 'en')).toBe(
            'Ella {n}'
        );
    });

    it('covers number and date arguments, not only plain ones', () => {
        expect(interpolate('{amt, number} due', { amt: null }, 'en')).toBe('{amt} due');
        expect(interpolate('{when, date} due', { when: null }, 'en')).toBe('{when} due');
    });

    it('control: an ABSENT argument behaves identically', () => {
        // If this and the null cases ever diverge, ICU-2's "null is missing"
        // has stopped holding somewhere in the path.
        expect(interpolate('{name} has {count, plural, one {# item} other {# items}}', { count: 2 }, 'en')).toBe(
            '{name} has 2 items'
        );
    });
});

describe('interpolate — debug notice for defaulted arguments', () => {
    // The fallback above is silent by design in production, which is also what
    // makes the argument undiscoverable: it never appears in the source phrase,
    // so nothing tells a developer that `{name}` became `{name_gender, select,
    // …}` in Spanish and that their app could be supplying it.
    //
    // Each test uses its own template because the notice is deduped per
    // template+locale for the process lifetime.
    const template = (branch: string) =>
        `{u_gender, select, male {Invitado ${branch}} female {Invitada ${branch}} other {Invitado/a ${branch}}}`;

    function captureWarnings(run: () => void): string[] {
        const seen: string[] = [];
        const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
            seen.push(args.map(String).join(' '));
        });
        try {
            run();
        } finally {
            spy.mockRestore();
        }
        return seen;
    }

    afterEach(() => {
        logger.debugEnabled = false;
    });

    it('names the missing argument when debug is on', () => {
        logger.debugEnabled = true;
        const warnings = captureWarnings(() => interpolate(template('a'), {}, 'es'));

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('u_gender');
        expect(warnings[0]).toContain('es');
    });

    it('says nothing in production', () => {
        expect(captureWarnings(() => interpolate(template('b'), {}, 'es'))).toHaveLength(0);
    });

    it('says nothing when the argument was supplied', () => {
        logger.debugEnabled = true;
        expect(captureWarnings(() => interpolate(template('c'), { u_gender: 'female' }, 'es'))).toHaveLength(0);
    });

    it('warns once per template, not once per render', () => {
        logger.debugEnabled = true;
        const tpl = template('d');

        const warnings = captureWarnings(() => {
            for (let i = 0; i < 5; i++) interpolate(tpl, {}, 'es');
        });

        expect(warnings).toHaveLength(1);
    });

    it('warns separately for each locale', () => {
        logger.debugEnabled = true;
        const tpl = template('e');

        const warnings = captureWarnings(() => {
            interpolate(tpl, {}, 'es');
            interpolate(tpl, {}, 'fr');
        });

        expect(warnings).toHaveLength(2);
    });

    it('also names a defaulted plural argument, not only selects', () => {
        logger.debugEnabled = true;
        const tpl = '{msg_count, plural, one {# mensaje nuevo} other {# mensajes nuevos}}';

        const warnings = captureWarnings(() => interpolate(tpl, {}, 'es'));

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('msg_count');
    });
});
