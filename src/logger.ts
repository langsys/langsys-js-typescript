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

const supportsStyle = typeof window !== 'undefined';

function emit(level: 'log' | 'warn' | 'error', label: string, args: unknown[]) {
    // Browsers render %c style. Node just gets the plain string.
    if (supportsStyle) {
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
