import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Type-level checks for `t()`'s signature, which the runtime suite cannot see and
 * `npm run typecheck` does not cover (it compiles `src/` only). The fixtures are
 * compiled with the project's own compiler options.
 */

function diagnosticsOf(file: string): ts.Diagnostic[] {
    const configPath = resolve(__dirname, '../tsconfig.json');
    const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config, ts.sys, resolve(__dirname, '..'));
    const program = ts.createProgram([resolve(__dirname, file)], { ...options, noEmit: true, declaration: false, declarationMap: false });
    return ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName.endsWith(file.split('/').pop()!));
}

const describeDiagnostic = (d: ts.Diagnostic) =>
    `${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : '?'}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;

describe('t() signature', () => {
    it('MIG-2: a key-shaped phrase accepts params; a sentence’s placeholders stay checked', () => {
        expect(diagnosticsOf('types/t-signature.ts').map(describeDiagnostic)).toEqual([]);
    }, 30_000);

    it('control: the same bad calls without @ts-expect-error each fail to compile', () => {
        const lines = diagnosticsOf('types/t-signature.control.ts').map((d) => d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1);
        expect(new Set(lines).size).toBe(3);
    }, 30_000);
});
