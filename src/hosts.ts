import { logger } from './logger.js';
import { activeScope } from './scope-context.js';

/**
 * Which marked hosts already have an instance managing them.
 *
 * A `Translate` or `Phrase` claims its element when it is constructed. An
 * enclosing `Translate` that meets a marked host no instance claims — markup a
 * server rendered, or a vanilla page that marked an element without wrapping
 * it — takes the host over itself (MARK-2, MARK-3), so the host registers as
 * the unit its marker declares instead of never registering at all.
 *
 * An instance an author constructs outranks one a walk created: claiming a host
 * whose claim came from a walk destroys that instance first, so a host is never
 * rendered or registered by two instances at once.
 */

interface Instance {
    destroy(): void;
}

interface Claim {
    instance: Instance;
    /** True when an enclosing walk created the instance, not the author. */
    byWalk: boolean;
}

const claims = new WeakMap<Element, Claim>();

/** Record that `instance` manages `host`, replacing an instance a walk created there. */
export function claimHost(host: Element, instance: Instance, byWalk = false): void {
    const existing = claims.get(host);
    if (existing && existing.byWalk && existing.instance !== instance) existing.instance.destroy();
    claims.set(host, { instance, byWalk });
}

/** Drop `instance`'s claim on `host`, if it still holds it. */
export function releaseHost(host: Element, instance: Instance): void {
    if (claims.get(host)?.instance === instance) claims.delete(host);
}

const warnedInert = new Set<string>();

/**
 * True, warning once per class, when a DOM class is constructed inside a request
 * scope (SRV-7). Its registration and subscriptions would run after the scope
 * has ended, outside it: phrases posted during the request, a block recorded as
 * loose phrases, and a later process emission re-rendering the host. So under a
 * scope it does nothing, and the server renders through `renderBlock` and
 * registers through `registerBlock`.
 */
export function inertUnderScope(className: string): boolean {
    if (!activeScope()) return false;
    if (!warnedInert.has(className)) {
        warnedInert.add(className);
        logger.warn(
            `${className} was constructed inside a request scope and does nothing there: render the block with renderBlock() and register it with registerBlock(), which complete inside the scope.`
        );
    }
    return true;
}

/** Whether an instance manages `host`. */
export function isHostManaged(host: Element): boolean {
    return claims.has(host);
}
