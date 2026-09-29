import { logger } from './logger.js';

/**
 * Debug notices: said once per process per reason, at debug level, and nothing
 * with debug off.
 *
 * A notice raised before `init()` is held, because debug is not known yet: a
 * component rendering before the app calls `init()` (a child's setup runs before
 * its layout's mount) would otherwise lose it. `init()` settles the queue: the
 * held notices are said when it turns debug on, and dropped when it does not.
 */

const said = new Set<string>();
const held = new Map<string, string>();
let settled = false;

/** Say `message` once for `key`, at debug level; before `init()`, hold it until debug is known. */
export function debugNotice(key: string, message: string): void {
    if (said.has(key)) return;
    if (!settled) {
        if (!held.has(key)) held.set(key, message);
        return;
    }
    if (!logger.debugEnabled) return;
    said.add(key);
    logger.log(message);
}

/** Called by `init()` once it has set debug: say what was held, or drop it. */
export function settleNotices(): void {
    settled = true;
    const pending = [...held];
    held.clear();
    for (const [key, message] of pending) debugNotice(key, message);
}

/** Test seam: forget what was said and held, and wait for `init()` again. */
export function _resetNotices(): void {
    said.clear();
    held.clear();
    settled = false;
}

/** The reasons `register: false` or a binding may name, with what the notice says for each. */
const UNREGISTERED: Record<string, string> = {
    'register-false': 'A <Translate> or <Phrase> was created with `register: false`: it renders from the catalog and registers nothing (VAR-7).',
};

/**
 * Report, as a debug notice once per process per reason, that a unit registers
 * nothing because the text it holds came from a variable that cannot be named
 * (VAR-7): `register: false` on a DOM class, or a binding without its build-time
 * transform. Its catalogued translations still render. The reason names the cause,
 * such as the transform to enable.
 */
export function warnUnregistered(reason: string): void {
    debugNotice(
        `unregistered\0${reason}`,
        UNREGISTERED[reason] ??
            `A <Translate> or <Phrase> registers nothing (${reason}): it holds a value from a variable that cannot be named without the build-time transform, so it renders from the catalog only (VAR-7).`
    );
}
