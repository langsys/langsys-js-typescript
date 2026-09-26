/**
 * Compiled by `type-level.test.ts`, never run. Every call below must typecheck, and
 * every `@ts-expect-error` must be needed: an unused one is itself an error, so a
 * change that stops rejecting a bad call fails the compile as surely as one that
 * starts rejecting a good call.
 */
import type { TFunction } from '../../src/types/translation-fn.js';

declare const t: TFunction;
declare const dynamic: string;

// MIG-2: in the legacy-key mode a key's value has placeholders the call site cannot see.
t('checkout.greet', { name: 'Ada' });
t('checkout.greet', 'Buttons', { name: 'Ada' });
t('checkout.greet');
t('checkout.greet', 'Buttons');
t('items_count', { count: 3 });

// A sentence's placeholders are still checked.
t('Hello {name}', { name: 'Ada' });
t('Hello {name}', 'Greetings', { name: 'Ada' });
// @ts-expect-error: a placeholder the phrase does not name
t('Hello {name}', { nope: 1 });
// @ts-expect-error: the placeholder's param is required
t('Hello {name}');
// @ts-expect-error: a placeholder-free sentence takes no params
t('Hello there', { name: 'Ada' });
// @ts-expect-error: nor does one ending in a period
t('Welcome back.', 'UI', { name: 'Ada' });

// A phrase known only as `string` is not checked.
t(dynamic, { name: 'Ada' });
t(dynamic, 'UI', { name: 'Ada' });
