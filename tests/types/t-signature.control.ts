/**
 * The control for `t-signature.ts`: bad calls with no `@ts-expect-error`. Compiled by
 * `type-level.test.ts`, which asserts each line fails, so a harness that reports no
 * diagnostics for anything cannot pass.
 */
import type { TFunction } from '../../src/types/translation-fn.js';

declare const t: TFunction;

t('Hello there', { name: 'Ada' });
t('Hello {name}', { nope: 1 });
t('Hello {name}');
