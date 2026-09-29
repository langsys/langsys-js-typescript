/**
 * Compile-time checks for t()'s params, run by `npm run typecheck` (tsconfig.types.json).
 * Nothing here executes: every line either compiles or carries @ts-expect-error.
 */
import { t } from '../../src/index';

declare const user: { name: string; gender: string };

// Plain placeholders are required and exact.
t('Hello, {name}!', 'Greetings', { name: user.name });
// @ts-expect-error missing `name`
t('Hello, {name}!', 'Greetings', {});
// @ts-expect-error `nme` is not a placeholder in the phrase
t('Hello, {name}!', 'Greetings', { name: user.name, nme: 'x' });

// Langsys promotes "{username}" to "{username_gender, select, …}" in gendered locales, so
// every placeholder may be accompanied by an optional `<name>_gender`. It is optional: most
// apps don't know the gender, and the SDK then renders the neutral `other` branch.
t('{username} has been invited', 'Team', { username: user.name, username_gender: user.gender });
t('{username} has been invited', 'Team', { username: user.name });
t('{username} has been invited', { username: user.name, username_gender: 'female' });
// @ts-expect-error only placeholders get a gender companion
t('{username} has been invited', 'Team', { username: user.name, team_gender: 'female' });
// @ts-expect-error the companion doesn't replace the placeholder
t('{username} has been invited', 'Team', { username_gender: 'female' });
// @ts-expect-error a phrase without placeholders still takes no params
t('Save', 'UI', { save_gender: 'female' });
