import { readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';

// The effective result of this file is pinned by tests/guard-snapshots/eslint.json (see AGENTS.md):
// change a rule or an option and that snapshot must be regenerated deliberately.

// Extension areas under src/, discovered from the file system so that a new one (src/sidepanel)
// automatically gets the boundary rules and every other area is forbidden to import it.
const CONTEXTS = readdirSync(join(import.meta.dirname, 'src'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'shared')
  .map((entry) => entry.name);

const typed = (project) => ({
  languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
});

// --- test code (everything under tests/): nothing may skip, focus, retry, reconfigure or sleep ----
const ROOTS = '/^(test|it|describe|suite)$/';
const MODIFIERS = '/^(skip|fixme|only|todo|skipIf|runIf|fails|fail)$/';
// test.skip, test.describe.skip, playwright.test.step.skip, ...: any chain rooted in a test API.
const ROOTED = `:matches(${[
  'object.name',
  'object.property.name',
  'object.object.name',
  'object.object.property.name',
  'object.object.object.name',
]
  .map((path) => `[${path}=${ROOTS}]`)
  .join(', ')})`;
const CALLS_TEST = `CallExpression:matches([callee.name=${ROOTS}], [callee.object.name=${ROOTS}], [callee.object.property.name=${ROOTS}])`;
const SLEEPS = '/^(setTimeout|setInterval|setImmediate|waitForTimeout)$/';
const MODIFIER_MESSAGE =
  'Tests may not be skipped, focused, todo, expected to fail, aliased, registered conditionally or reconfigured (configure may only set mode).';
const SLEEP_MESSAGE =
  'No sleeping in tests (waitForTimeout, timers, networkidle) and no dynamic import(). Use web-first assertions, expect.poll or waitForFunction.';
const TEST_SELECTORS = [
  ...[
    `MemberExpression[property.name=${MODIFIERS}]${ROOTED}`,
    `MemberExpression[property.value=${MODIFIERS}]${ROOTED}`,
    `VariableDeclarator:matches([init.name=${ROOTS}], [init.object.name=${ROOTS}], [init.property.name=${ROOTS}])`,
    `AssignmentExpression:matches([right.name=${ROOTS}], [right.object.name=${ROOTS}])`,
    ...['test', 'it', 'describe', 'suite'].map(
      (name) => `ImportSpecifier[imported.name='${name}'][local.name!='${name}']`,
    ),
    `:matches(IfStatement, SwitchStatement, ConditionalExpression, LogicalExpression) ${CALLS_TEST}`,
    // configure({ retries, timeout, ... }) hides retries; only { mode } is allowed.
    "CallExpression[callee.property.name='configure']:not([arguments.0.type='ObjectExpression'])",
    "CallExpression[callee.property.name='configure'] > ObjectExpression > Property[key.name!='mode']",
    "CallExpression[callee.property.name='configure'] > ObjectExpression > Property[computed=true]",
    "CallExpression[callee.property.name='configure'] > ObjectExpression > SpreadElement",
  ].map((selector) => ({ selector, message: MODIFIER_MESSAGE })),
  ...[
    "MemberExpression[property.name='waitForTimeout']",
    "MemberExpression[property.value='waitForTimeout']",
    "ObjectPattern > Property[key.name='waitForTimeout']",
    // test.setTimeout() / testInfo.setTimeout() set a timeout and are fine; any other reference is a sleep.
    "Identifier[name='setTimeout']:not(MemberExpression[object.name=/^(test|testInfo)$/] > Identifier.property)",
    'Identifier[name=/^(setInterval|setImmediate)$/]',
    `Literal[value=${SLEEPS}]`,
    `TemplateLiteral[quasis.length=1][quasis.0.value.cooked=${SLEEPS}]`,
    "Literal[value='networkidle']",
    'ImportExpression',
  ].map((selector) => ({ selector, message: SLEEP_MESSAGE })),
];
const timerImports = (extraPatterns = []) => [
  'error',
  {
    paths: ['timers', 'node:timers', 'timers/promises', 'node:timers/promises'].map((name) => ({
      name,
      message: SLEEP_MESSAGE,
    })),
    patterns: [{ group: ['timers/*', 'node:timers/*'], message: SLEEP_MESSAGE }, ...extraPatterns],
  },
];

// --- extension code (src/) ------------------------------------------------------------------------
const NODE_BUILTINS = [
  ...new Set(
    builtinModules
      .map((name) => name.replace(/^node:/, ''))
      .filter((name) => !name.startsWith('_')),
  ),
];
const NODE_MESSAGE = 'No Node built-ins in extension code.';
const FORMAT_MESSAGE =
  'No number formatting in extension code (FontSnap shows its scores through percentLabel in src/shared/ui.ts); a locale-aware format needs src/shared/format.ts from the template.';
const noDynamicImport = {
  selector: 'ImportExpression',
  message: 'No dynamic import() in extension code; import statically.',
};
// ES modules checked by tsc: no CommonJS require, and no `declare` to talk the type system into
// believing in globals (ambient declarations live in src/env.d.ts only).
const noRequireOrDeclare = [
  ...["CallExpression[callee.name='require']", "MemberExpression[object.name='require']"].map(
    (selector) => ({ selector, message: 'No CommonJS require() in extension code.' }),
  ),
  ...[
    'TSModuleDeclaration',
    'TSDeclareFunction',
    'VariableDeclaration[declare=true]',
    'FunctionDeclaration[declare=true]',
    'ClassDeclaration[declare=true]',
    'TSEnumDeclaration[declare=true]',
  ].map((selector) => ({
    selector,
    message: 'No ambient declarations or namespaces outside .d.ts files.',
  })),
];
// Code that is loaded or built at run time is invisible to lint, tsc and coverage. A name can be
// written as an identifier (`a.eval`), a string (`a['eval']`) or a template (`a[`eval`]`), and a
// value as a string or a template without expressions; every spelling is matched. (Names assembled
// at run time are the accepted boundary; the CSP forbids eval and remote scripts as well.)
const valued = (path, values) =>
  `:matches([${path}.value=${values}], [${path}.quasis.0.value.cooked=${values}])`;
const named = (path, names) =>
  `:matches([${path}.name=${names}], [${path}.value=${names}], [${path}.quasis.0.value.cooked=${names}])`;
const ELEMENTS = '/^(script|iframe|frame|embed|object)$/i';
const injectedCodeSelectors = [
  // createElement('script'), createElement(`script`), el['createElement'](...), createElementNS(ns, 'script')
  `CallExpression${named('callee.property', "'createElement'")}${valued('arguments.0', ELEMENTS)}`,
  `CallExpression${named('callee.property', "'createElementNS'")}${valued('arguments.1', ELEMENTS)}`,
  // eval and the Function constructor, in any form: eval(), globalThis.eval(), (0, eval)(), aliases, new Function
  "Identifier[name='eval']",
  "Identifier[name='Function']",
  `MemberExpression[computed=true]${named('property', '/^(eval|Function|importScripts)$/')}`,
  "Identifier[name='importScripts']",
  // setTimeout('code') / setInterval(`code`), also window['setTimeout'](...)
  `CallExpression:matches([callee.name=/^(setTimeout|setInterval)$/], ${named('callee.property', '/^(setTimeout|setInterval)$/')})[arguments.0.type=/^(Literal|TemplateLiteral)$/]`,
  // document.write(...) through any object or computed member (src/ has no other use of write)
  `CallExpression${named('callee.property', '/^(write|writeln)$/')}`,
  // The Function constructor without the name Function: (() => {}).constructor('code'), x['constructor'](...)
  `CallExpression${named('callee.property', "'constructor'")}`,
  `NewExpression${named('callee.property', "'constructor'")}`,
];
// Allowlists are Maps, Sets or Object.hasOwn: `key in object` also finds what every object inherits
// (constructor, toString, __proto__), and `evil.constructor` once passed the media gate that way.
const noDynamicIn = [
  {
    selector: "BinaryExpression[operator='in']:not([left.type='Literal'])",
    message:
      'No `key in object` with a dynamic key (it finds inherited names like constructor): use a Map, a Set or Object.hasOwn.',
  },
];
const noInjectedCode = [
  ...injectedCodeSelectors.map((selector) => ({
    selector,
    message:
      'No code loaded or built at run time (script/iframe/embed/object elements, eval, Function, importScripts, setTimeout with a string, document.write).',
  })),
  // WebAssembly is intentionally not supported (see README.md): no .wasm files, no ?init imports, no
  // 'wasm-unsafe-eval' in the CSP, and no use of the API.
  ...[
    "Identifier[name='WebAssembly']",
    `MemberExpression[computed=true]${named('property', "'WebAssembly'")}`,
  ].map((selector) => ({
    selector,
    message:
      'WebAssembly is intentionally not supported by this template (it needs wasm-unsafe-eval in the CSP); see "WebAssembly" in README.md.',
  })),
];
const numbersAndText = [
  ...[
    "MemberExpression[property.name='NumberFormat']",
    "MemberExpression[computed=true][property.value='NumberFormat']",
    "ObjectPattern > Property[key.name='NumberFormat']",
    "MemberExpression[property.name='toFixed']",
    "MemberExpression[property.name='toLocaleString']",
  ].map((selector) => ({ selector, message: FORMAT_MESSAGE })),
  {
    selector:
      'AssignmentExpression[left.property.name=/^(textContent|innerText|innerHTML)$/][right.type=/^(Literal|TemplateLiteral)$/]',
    message: 'UI text must come from chrome.i18n (t() or data-i18n), not literals.',
  },
];

/** `src/shared` imports no area, an area imports only `shared`, and nothing imports Node built-ins. */
const restrictImports = (others) => ({
  'no-restricted-imports': [
    'error',
    {
      // Bare names include sub-paths ('fs/promises'); the node: prefix is one pattern, so an
      // import is reported once.
      paths: NODE_BUILTINS.map((name) => ({ name, message: NODE_MESSAGE })),
      patterns: [
        { group: ['node:*'], message: NODE_MESSAGE },
        ...others.map((name) => ({
          group: [`**/${name}`, `**/${name}/**`],
          message: `Move shared code to src/shared instead of importing from ${name}.`,
        })),
      ],
    },
  ],
});

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      'dist-e2e',
      'release',
      'coverage',
      'reports',
      'playwright-report',
      'test-results',
      '.superpowers',
    ],
  },
  {
    // Inline configuration is never honoured, so no comment can weaken a rule. ESLint warns about
    // each directive (lint runs with --max-warnings=0) and no-use below forbids them outright.
    linterOptions: { reportUnusedDisableDirectives: 'error', noInlineConfig: true },
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  // Extension code is type-checked without Node types; everything else with them.
  { files: ['src/**/*.ts'], ...typed('./tsconfig.src.json') },
  { files: ['tests/**/*.ts', 'scripts/**/*.ts', '*.ts'], ...typed('./tsconfig.node.json') },
  comments.recommended,
  {
    rules: {
      '@eslint-community/eslint-comments/no-use': ['error', { allow: [] }],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/dot-notation': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/shared/format.ts', 'src/**/*.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
      ],
    },
  },
  {
    files: ['src/shared/format.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
      ],
    },
  },
  {
    files: ['src/**/*.d.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
      ],
    },
  },
  { files: ['src/shared/**/*.ts'], rules: restrictImports(CONTEXTS) },
  ...CONTEXTS.map((context) => ({
    files: [`src/${context}/**/*.ts`],
    rules: restrictImports(CONTEXTS.filter((other) => other !== context)),
  })),
  { files: ['src/*.ts'], rules: restrictImports([]) },
  {
    files: ['scripts/**/*.ts', '*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...noDynamicIn] },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...TEST_SELECTORS],
      'no-restricted-properties': [
        'error',
        { property: 'waitForTimeout', message: SLEEP_MESSAGE },
        { property: 'setInterval', message: SLEEP_MESSAGE },
      ],
      'no-restricted-imports': timerImports(),
    },
  },
  {
    // e2e helpers are linted like e2e tests; unit helpers (which may use fake timers) are not theirs.
    files: ['tests/e2e/**/*.ts'],
    rules: {
      'no-restricted-imports': timerImports([
        { group: ['**/unit', '**/unit/**'], message: 'e2e tests do not import unit-test code.' },
      ]),
    },
  },
  {
    ...playwright.configs['flat/recommended'],
    files: ['tests/e2e/**/*.ts'],
    rules: {
      ...playwright.configs['flat/recommended'].rules,
      'playwright/no-skipped-test': ['error', { disallowFixme: true }],
      'playwright/no-focused-test': 'error',
      'playwright/no-wait-for-timeout': 'error',
    },
  },
  {
    ...vitest.configs.recommended,
    files: ['tests/unit/**/*.ts'],
    rules: {
      ...vitest.configs.recommended.rules,
      // expect(value, 'message') is how failures name the offending item.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
