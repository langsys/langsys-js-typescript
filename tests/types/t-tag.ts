/**
 * Compiled by `type-level.test.ts`, never run. `t` as a template tag, as the README writes it,
 * typechecks with every `t` the package exports, and returns a string. Every `@ts-expect-error`
 * must be needed, so the tag form cannot loosen the call form's checks.
 */
import { LangsysApp, t, tSignal } from '../../src/index.js';

const name = 'Ana';
const count = 3;

const greeting: string = t`Hello ${{ name }}`;
const page: string = LangsysApp.t`Hello ${{ name }}, you have ${{ count }} messages`;
const reactive: string = tSignal.get()`Welcome back, ${{ name }}`;
// A value with no name renders, and registers nothing.
const unnamed: string = t`Hello ${name}`;
void [greeting, page, reactive, unnamed];

// @ts-expect-error a plain array is not a template's strings
t(['Hello ', '']);
// @ts-expect-error a call's params are still checked against its placeholders
t('Hello {name}', { nmae: name });
// @ts-expect-error a call still needs the params its placeholders name
t('Hello {name}');
