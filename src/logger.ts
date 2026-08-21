/**
 * Lightweight debug logger. Styled in browsers (via %c), plain text in Node.
 * Replaces the pre-existing `echo` module from the Svelte SDK with a simpler,
 * SSR-safe equivalent.
 */

const STYLES = {
    log: 'display:inline-block;background:rgb(239,239,244);color:black;font-weight:bold;padding:3px 7px;border-radius:3px',
    warn: 'display:inline-block;background:gold;color:black;font-weight:bold;padding:3px 7px;border-radius:3px',
    error: 'display:inline-block;background:#e0005a;color:#fff;font-weight:bold;padding:3px 7px;border-radius:3px',
};

/**
 * React Native defines `window`, so a bare `typeof window` check treats it as a
 * browser — and its console does not render `%c`, so every line comes out as a
 * literal "%cLangsys Debug" followed by an unrendered CSS string. Nothing
 * breaks, so nothing reports it; it just looks broken forever.
 * `navigator.product === 'ReactNative'` is the standard discriminator.
 *
 * Evaluated per call rather than once at module load: this module is commonly
 * imported before a host finishes installing its globals, and a value latched
 * at import time cannot be corrected afterwards — nor observed by a test,
 * which is how the browser branch would go unverified.
 */
function supportsStyle(): boolean {
    if (typeof window === 'undefined') return false;
    return !(typeof navigator !== 'undefined' && navigator.product === 'ReactNative');
}

function emit(level: 'log' | 'warn' | 'error', label: string, args: unknown[]) {
    // Browsers render %c style. Node just gets the plain string.
    if (supportsStyle()) {
        // eslint-disable-next-line no-console
        console[level](`%c${label}`, STYLES[level], ...args);
    } else {
        // eslint-disable-next-line no-console
        console[level](`[${label}]`, ...args);
    }
}

export class Logger {
    debugEnabled: boolean;

    constructor(debugEnabled = false) {
        this.debugEnabled = debugEnabled;
    }

    log(...args: unknown[]) {
        if (!this.debugEnabled) return;
        emit('log', 'Langsys Debug', args);
    }

    warn(...args: unknown[]) {
        emit('warn', 'Langsys Warning', args);
    }

    error(...args: unknown[]) {
        emit('error', 'Langsys Error', args);
    }
}

export const logger = new Logger(false);
