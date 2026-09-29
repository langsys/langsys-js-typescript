/**
 * Placeholder names from source expressions (spec VAR-2). A name matches
 * `[a-z][a-z0-9_]*`, so it is a valid ICU argument, and it is derived the same way
 * by every SDK, because the name is part of the phrase: two SDKs naming the same
 * expression differently register two phrases.
 *
 * Expressions are given as a language-neutral shape, the one the shared naming
 * vectors (`var-naming-vectors.json`) use, so a binding maps its own AST onto it.
 */

/** An expression that produced a value, as the naming rules see it. */
export type ExpressionShape =
    | { identifier: string }
    | { member: string[] }
    | { call: { callee: string; args: ExpressionShape[] } }
    | { other: 'binary' | 'conditional' | 'template' | 'computed' | 'call-multi' | string };

/** One value in a phrase: its expression, and the name the developer wrote, if any. */
export interface NamedExpression {
    shape: ExpressionShape;
    /** An explicit name always wins. */
    explicit?: string;
}

const GRAMMAR = /^[a-z][a-z0-9_]*$/;
/** `<Phrase>`'s markup tokens. */
const RESERVED = /^m\d+[oc]$/;
const COUNT = new Set(['length', 'size', 'count']);
const VALUE = new Set(['value', 'current']);

/** A segment in snake_case, within the grammar, or null when nothing of it survives. */
export function snakeCase(segment: string): string | null {
    const snake = segment
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[^a-z]+/, '')
        .replace(/_+$/, '');
    return snake && GRAMMAR.test(snake) ? snake : null;
}

/** The name an expression derives on its own, and the segment before it, for a collision's prefix. */
function derive(shape: ExpressionShape): { name: string; prev: string | null } | null {
    if ('identifier' in shape) {
        const name = snakeCase(shape.identifier);
        return name ? { name, prev: null } : null;
    }
    if ('member' in shape) {
        const segments = shape.member;
        if (segments.length === 0) return null;
        const last = segments[segments.length - 1]!;
        if (segments.length >= 2 && (COUNT.has(last) || VALUE.has(last))) {
            const base = snakeCase(segments[segments.length - 2]!);
            if (!base) return null;
            const prev = segments.length >= 3 ? snakeCase(segments[segments.length - 3]!) : null;
            return { name: COUNT.has(last) ? `${base}_count` : base, prev };
        }
        const name = snakeCase(last);
        if (!name) return null;
        return { name, prev: segments.length >= 2 ? snakeCase(segments[segments.length - 2]!) : null };
    }
    if ('call' in shape) {
        return shape.call.args.length === 1 ? derive(shape.call.args[0]!) : null;
    }
    return null;
}

const key = (shape: ExpressionShape) => JSON.stringify(shape);

/**
 * The placeholder name of each value in one phrase, in order (VAR-2):
 *
 * - an explicit name wins;
 * - an identifier is itself in snake_case; a member chain its last segment; a
 *   chain ending in `length`, `size` or `count` the segment before plus `_count`;
 *   one ending in `value` or `current` the segment before; a call with one
 *   argument the argument's name;
 * - the same expression twice is the same placeholder;
 * - names that collide are prefixed with their previous segment, then suffixed
 *   `_2`, `_3`, and a reserved name (`m0o`) counts as taken;
 * - anything else is `value`, `value_2`, ….
 */
export function derivePlaceholderNames(expressions: readonly NamedExpression[]): string[] {
    const names: Array<string | null> = expressions.map((e) => (e.explicit ? snakeCase(e.explicit) ?? e.explicit : null));
    const taken = new Set(names.filter((n): n is string => n !== null));
    const derived = expressions.map((e, i) => (names[i] === null ? derive(e.shape) : null));

    // The same expression is one placeholder: its later occurrences take the first's name.
    const firstOf = new Map<string, number>();
    const sameAs = expressions.map((e, i) => {
        if (names[i] !== null) return i;
        const k = key(e.shape);
        if (!firstOf.has(k)) firstOf.set(k, i);
        return firstOf.get(k)!;
    });

    // Derived names wanted by more than one distinct expression, or taken already, collide.
    const wanted = new Map<string, number[]>();
    derived.forEach((d, i) => {
        if (d && sameAs[i] === i) wanted.set(d.name, [...(wanted.get(d.name) ?? []), i]);
    });
    const claim = (name: string): string => {
        let candidate = name;
        for (let n = 2; taken.has(candidate) || RESERVED.test(candidate); n++) candidate = `${name}_${n}`;
        taken.add(candidate);
        return candidate;
    };
    for (let i = 0; i < expressions.length; i++) {
        if (names[i] !== null || sameAs[i] !== i) continue;
        const d = derived[i];
        if (!d) continue;
        const collides = (wanted.get(d.name)?.length ?? 0) > 1 || taken.has(d.name) || RESERVED.test(d.name);
        names[i] = claim(collides && d.prev ? `${d.prev}_${d.name}` : d.name);
    }
    for (let i = 0; i < expressions.length; i++) {
        if (names[i] === null && sameAs[i] === i) names[i] = claim('value');
    }
    return expressions.map((_, i) => names[sameAs[i]!]!);
}
