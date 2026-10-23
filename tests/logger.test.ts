import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('the logger picks its formatting from the host console', () => {
    it('uses %c styling in a browser', () => {
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', { product: 'Gecko' });
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

        new Logger(true).log('hello');

        expect(String(spy.mock.calls[0]?.[0])).toContain('%c');
    });

    it('uses plain text in React Native, which defines window but cannot render %c', () => {
        // RN has a `window`, so the browser test alone is satisfied there — and
        // the result is every log line reading a literal "%cLangsys Debug"
        // followed by an unrendered CSS string. Nothing breaks, so nothing
        // reports it; it just looks broken forever.
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', { product: 'ReactNative' });
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

        new Logger(true).log('hello');

        const first = String(spy.mock.calls[0]?.[0]);
        expect(first).not.toContain('%c');
        expect(first).toContain('[Langsys Debug]');
    });

    it('uses plain text in Node, where there is no window at all', () => {
        vi.stubGlobal('window', undefined);
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

        new Logger(true).log('hello');

        expect(String(spy.mock.calls[0]?.[0])).toContain('[Langsys Debug]');
    });
});
