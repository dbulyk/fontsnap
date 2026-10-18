import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

// What guards.test.ts cannot show: that the selectors in eslint.config.js really match the code
// they are meant to stop. The config itself (rules and options) is pinned by the guard snapshots.

const eslint = new ESLint();
const RULES = ['no-restricted-syntax', 'no-restricted-properties', 'no-restricted-imports'];

/** Messages of the restriction rules, as configured for `file` in eslint.config.js, for `code`. */
async function flagged(file: string, code: string): Promise<string[]> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  const rules = Object.fromEntries(
    RULES.flatMap((name) => {
      const entry = config.rules?.[name];
      return entry === undefined ? [] : [[name, entry] as const];
    }),
  );
  expect(Object.keys(rules), `${file} has restriction rules`).not.toEqual([]);
  const messages = new Linter().verify(code, [
    { languageOptions: { parser: tseslint.parser }, rules },
  ]);
  return messages.map((message) => message.message);
}

const TEST_FILES = [
  'tests/e2e/welcome.spec.ts',
  'tests/unit/ui.test.ts',
  'tests/unit/helpers/chrome-stub.ts',
  'tests/support/anything.ts',
];

describe('test code: modifiers, conditional registration, aliases', () => {
  it.each([
    "test.fixme('x', () => undefined);",
    "test.skip('x', () => undefined);",
    "test.only('x', () => undefined);",
    "test.fail('x', () => undefined);",
    "it.skipIf(true)('x', () => undefined);",
    "it.runIf(false)('x', () => undefined);",
    "it.todo('x');",
    "it.fails('x', () => undefined);",
    "it.skip('x', () => undefined);",
    "describe.only('x', () => undefined);",
    "describe.skipIf(true)('x', () => undefined);",
    "suite.skip('x', () => undefined);",
    "test.describe.skip('x', () => undefined);",
    "test.describe.fixme('x', () => undefined);",
    "test.step.skip('x', () => undefined);",
    "test['skip']('x', () => undefined);",
    "playwright.test.skip('x', () => undefined);",
    'const { skip } = test;',
    'const { fixme } = test.describe;',
    'const { step } = test;',
    'const alias = test;',
    'const t2 = it;',
    'const steps = test.step;',
    'const t3 = playwright.test;',
    'let t4; t4 = test;',
    "import { test as t } from '@playwright/test';",
    "import { it as t } from 'vitest';",
    "if (process.env.X) { it('x', () => undefined); }",
    "const run = flag ? it : undefined; flag && test('x', () => undefined);",
    "if (flag) { test.describe('x', () => undefined); }",
    "switch (a) { case 1: it('x', () => undefined); }",
  ])('flags %s', async (code) => {
    for (const file of TEST_FILES) expect(await flagged(file, code), file).not.toEqual([]);
  });

  it.each([
    'test.describe.configure({ retries: 2 });',
    "test.describe.configure({ mode: 'serial', retries: 2 });",
    'test.describe.configure({ timeout: 1000 });',
    'test.describe.configure({ ...options });',
    'test.describe.configure(options);',
    "test.describe.configure({ ['retries']: 2 });",
    'describe.configure({ retries: 2 });',
  ])('flags %s (configure may only set mode)', async (code) => {
    for (const file of TEST_FILES) expect(await flagged(file, code), file).not.toEqual([]);
  });

  it('still allows the ordinary test API, slow(), setTimeout() and configure({ mode })', async () => {
    const code = [
      "test.describe('group', () => { test.use({ uiLocale: 'ru' }); });",
      "test.describe.configure({ mode: 'serial' });",
      "test('x', async ({ page }, testInfo) => { test.slow(); test.setTimeout(60_000); testInfo.setTimeout(1000); });",
      "it.each([1, 2])('n %i', () => undefined);",
      "describe('y', () => { it('z', () => undefined); });",
      "test('s', async () => { await test.step('inner', async () => undefined); });",
      'export const extended = playwright.test.extend({});',
    ].join('\n');
    for (const file of TEST_FILES) expect(await flagged(file, code), file).toEqual([]);
  });
});

describe('test code: no sleeping by any route, wherever the file lives under tests/', () => {
  it.each([
    'await page.waitForTimeout(500);',
    "await page['waitForTimeout'](500);",
    'await page[`waitForTimeout`](500);',
    'const { waitForTimeout } = page;',
    'const timer = globalThis.setTimeout.bind(globalThis);',
    'await new Promise((done) => window.setTimeout(done, 5));',
    "await new Promise((done) => globalThis['setTimeout'](done, 5));",
    'const nap = setTimeout;',
    'setInterval(() => undefined, 5);',
    'setImmediate(() => undefined);',
    "import { setTimeout as sleep } from 'node:timers/promises';",
    "import { setTimeout } from 'timers';",
    "import timers from 'node:timers';",
    "import { scheduler } from 'timers/promises';",
    "const { scheduler } = await import('node:timers/promises');",
    "const m = import('./anything');",
    "await page.waitForLoadState('networkidle');",
  ])('flags %s', async (code) => {
    for (const file of TEST_FILES) expect(await flagged(file, code), file).not.toEqual([]);
  });

  it('keeps e2e tests from importing unit-test helpers (which are not covered by the e2e rules)', async () => {
    expect(
      await flagged('tests/e2e/welcome.spec.ts', "import { pause } from '../unit/helpers/pause';"),
    ).not.toEqual([]);
  });
});

describe('extension code: boundaries, loading, number formatting and ambient declarations', () => {
  it.each([
    ['src/result/render.ts', "import { readFileSync } from 'fs';"],
    ['src/result/render.ts', "import { readFile } from 'fs/promises';"],
    ['src/result/render.ts', "import { readFile } from 'node:fs/promises';"],
    ['src/result/app.ts', "import { x } from '../background/handlers';"],
    ['src/shared/i18n.ts', "import { x } from '../result/render';"],
    ['src/welcome/app.ts', "await import('../result/render');"],
    ['src/result/render.ts', "new Intl.NumberFormat('en').format(1);"],
    ['src/result/render.ts', 'const { NumberFormat } = Intl;'],
    ['src/result/render.ts', 'const text = (5).toFixed(1);'],
    ['src/result/render.ts', "el.textContent = 'Hello';"],
    ['src/result/render.ts', 'declare const require: (name: string) => unknown;'],
    ['src/result/render.ts', "declare module 'fs' { export const a: number; }"],
    ['src/result/render.ts', "const fs = require('fs');"],
    // code loaded or built at run time, which no lint, type or coverage check can look into
    ['src/result/app.ts', "const s = doc.createElement('script'); doc.head.append(s);"],
    ['src/result/app.ts', "doc.body.append(doc.createElement('IFRAME'));"],
    ['src/result/app.ts', "document.createElement('embed');"],
    ['src/result/app.ts', "document.createElement('object');"],
    ['src/result/app.ts', "eval('1');"],
    ['src/result/app.ts', "new Function('return 1')();"],
    ['src/select/overlay.ts', "importScripts('x.js');"],
    ['src/select/overlay.ts', "document.write('<p>x</p>');"],
    ['src/shared/format.ts', "document.createElement('script');"],
    ['src/env.d.ts', "document.createElement('script');"],
  ])('%s rejects %s', async (file, code) => {
    expect(await flagged(file, code)).not.toEqual([]);
  });

  // Round 8: the same ideas spelled differently. Each of these slipped through the first selectors.
  it.each([
    ['a template literal', 'document.createElement(`script`);'],
    ['a template literal, upper case', 'document.createElement(`SCRIPT`);'],
    ['createElementNS', "document.createElementNS('http://www.w3.org/1999/xhtml', 'script');"],
    [
      'createElementNS, svg namespace',
      "document.createElementNS('http://www.w3.org/2000/svg', 'script');",
    ],
    ['createElementNS, template literal', 'document.createElementNS(ns, `script`);'],
    ['a computed member', "document['createElement']('script');"],
    ['a computed member, template literal', 'document[`createElement`](`iframe`);'],
    ['globalThis.eval', "globalThis.eval('1');"],
    ['window.eval', "window.eval('1');"],
    ['self.eval', "self.eval('1');"],
    ['a computed globalThis.eval', "globalThis['eval']('1');"],
    ['self.importScripts', "self.importScripts('x.js');"],
    ['globalThis.importScripts', "globalThis.importScripts('x.js');"],
    ['new globalThis.Function', "new globalThis.Function('return 1');"],
    ['an indirect eval', "(0, eval)('1');"],
    ['an aliased eval', 'const run = eval; run("1");'],
    ['Function called without new', "Function('return 1')();"],
    ['setTimeout with code in a string', "setTimeout('alert(1)', 0);"],
    ['setInterval with code in a template', 'setInterval(`alert(1)`, 0);'],
    ['window.setTimeout with a string', "window.setTimeout('alert(1)', 0);"],
    ['document.writeln', "document.writeln('<p>x</p>');"],
    ['WebAssembly.instantiate', 'WebAssembly.instantiate(bytes);'],
    ['new WebAssembly.Module', 'new WebAssembly.Module(bytes);'],
    ['globalThis.WebAssembly', 'globalThis.WebAssembly.compile(bytes);'],
    ['an alias of WebAssembly', 'const wasm = WebAssembly; wasm.validate(bytes);'],
  ])('rejects %s in extension code', async (_name, code) => {
    expect(await flagged('src/result/app.ts', code), code).not.toEqual([]);
  });

  // Round 9: the Function constructor reached without the name Function, and string code to a timer
  // through a computed member; document.write through any object or computed member.
  it.each([
    ['the constructor of an arrow function', "(() => undefined).constructor('alert(1)')();"],
    ['x.constructor(...)', "x.constructor('alert(1)');"],
    ["x['constructor'](...)", "x['constructor']('alert(1)');"],
    ['x[`constructor`](...)', "x[`constructor`]('alert(1)');"],
    ['new x.constructor(...)', "new x.constructor('alert(1)');"],
    ['an async function constructor', "(async () => undefined).constructor('alert(1)');"],
    ["window['setTimeout']('code')", "window['setTimeout']('alert(1)', 0);"],
    ['self[`setInterval`](`code`)', 'self[`setInterval`](`alert(1)`, 0);'],
    ["globalThis['setTimeout']('code')", "globalThis['setTimeout']('alert(1)');"],
    ['doc.write', "doc.write('<p>x</p>');"],
    ['document.write', "document.write('<p>x</p>');"],
    ["document['write']", "document['write']('<p>x</p>');"],
    ["document['writeln']", "document['writeln']('<p>x</p>');"],
    ['document[`write`]', "document[`write`]('<p>x</p>');"],
    ['writeln on any object', "d.writeln('<p>x</p>');"],
    ['ownerDocument.write', "el.ownerDocument.write('<p>x</p>');"],
    ['an alias of document.write', "const d = document; d.write('<p>x</p>');"],
    ['a dynamic key and the in operator', 'if (key in table) run();'],
    ['the in operator on a member', 'if (name in this.table) run();'],
  ])('rejects %s in extension code', async (_name, code) => {
    expect(await flagged('src/result/app.ts', code), code).not.toEqual([]);
  });

  it('allows the in operator with a literal key (narrowing a union), classes, and plain constructors', async () => {
    const code = [
      "if ('documentElement' in root) run();",
      'class A { constructor() { this.x = 1; } }',
      'const kind = this.constructor.name;',
      'const o = { constructor: 1, write: 2 };',
      'const s = new Set<string>(); s.has(key);',
    ].join('\n');
    expect(await flagged('src/result/render.ts', code)).toEqual([]);
  });

  it.each([
    ['scripts/lib/locales.ts', 'if (key in reference) run();'],
    ['scripts/lib/dist.ts', 'return name in table;'],
    ['vite.shared.ts', 'if (key in table) run();'],
  ])(
    '%s rejects the in operator with a dynamic key: use a Map, a Set or Object.hasOwn',
    async (file, code) => {
      expect(await flagged(file, code), code).not.toEqual([]);
    },
  );

  it('allows the in operator with a literal key in scripts', async () => {
    expect(await flagged('scripts/lib/tag.ts', "return 'error' in result;")).toEqual([]);
  });

  it('still lets code use timers with functions, and look at element names it does not create', async () => {
    const code = [
      'setTimeout(() => undefined, 5);',
      'window.setTimeout(callback, 5);',
      "const tag = el.tagName === 'SCRIPT';",
      "document.createElement('li');",
      'document.createElementNS(ns, `circle`);',
      'const evaluate = (x: number) => x;',
    ].join('\n');
    expect(await flagged('src/result/render.ts', code)).toEqual([]);
  });

  it('still lets code create ordinary elements', async () => {
    expect(await flagged('src/result/render.ts', "doc.createElement('li');")).toEqual([]);
  });

  it('lets format.ts, and only format.ts, use Intl.NumberFormat', async () => {
    const code = "new Intl.NumberFormat('en');";
    expect(await flagged('src/shared/format.ts', code)).toEqual([]);
    expect(await flagged('src/shared/settings.ts', code)).not.toEqual([]);
  });

  it('allows ambient declarations in .d.ts files', async () => {
    const code = "declare module '*.svg' { const url: string; export default url; }";
    expect(await flagged('src/env.d.ts', code)).toEqual([]);
  });
});

// onnxruntime-web can be pointed at other code through its environment: env.wasm.wasmPaths (another URL, a different
// .wasm) and env.wasm.wasmBinary (other bytes) run WebAssembly past the pinned files of scripts/lib/vendor.ts, with
// every build check green. So only src/result/model.ts, which a test pins line by line, may touch the runtime at all.
describe('onnxruntime-web is configured in src/result/model.ts and nowhere else', () => {
  const ORT_FILES = [
    'src/result/app.ts',
    'src/result/render.ts',
    'src/background/handlers.ts',
    'src/background/shot.ts',
    'src/shared/capture.ts',
    'src/shared/core/pipeline.ts',
    'src/select/overlay.ts',
    'src/welcome/app.ts',
    'src/manifest.ts',
    'src/env.d.ts',
  ];

  it.each([
    ['a member access', "ort.env.wasm.wasmPaths = 'https://cdn.example.com/ort/';"],
    ['wasmBinary', 'ort.env.wasm.wasmBinary = bytes;'],
    ['an object as wasmPaths', 'ort.env.wasm.wasmPaths = { wasm: url, mjs: url };'],
    ['an object key', "const options = { wasmPaths: 'https://cdn.example.com/' };"],
    ['a string key', "const options = { 'wasmBinary': bytes };"],
    ['a shorthand property', 'const wasmPaths = url; use({ wasmPaths });'],
    ['a destructured name', 'const { wasmBinary } = env.wasm;'],
    ['a renamed destructured name', 'const { wasmPaths: where } = settings;'],
    ['a computed string', "ort.env.wasm['wasmBinary'] = bytes;"],
    ['a computed template', 'ort.env.wasm[`wasmPaths`] = url;'],
    ['a template as a key', 'const o = { [`wasmBinary`]: bytes };'],
    ['reading it', 'const where = ort.env.wasm.wasmPaths;'],
    ['Object.assign on the environment', 'Object.assign(ort.env.wasm, config);'],
    ['Reflect.set with a string', "Reflect.set(ort.env.wasm, 'wasmBinary', bytes);"],
    ['the env of a destructured import', "const { env } = await load('x');"],
    ['an env member', 'globalThis.ort.env.wasm.numThreads = 8;'],
    ['a computed env', "ort['env'].wasm.numThreads = 8;"],
    ['an import of onnxruntime-web', "import * as ort from 'onnxruntime-web/wasm';"],
    ['another entry point', "import * as ort from 'onnxruntime-web';"],
    ['onnxruntime-node', "import * as ort from 'onnxruntime-node';"],
    ['a named import', "import { env } from 'onnxruntime-web/wasm';"],
    ['a re-export', "export * from 'onnxruntime-web/wasm';"],
    ['a named re-export', "export { env } from 'onnxruntime-web/wasm';"],
  ])('rejects %s', async (_name, code) => {
    for (const file of ORT_FILES)
      expect(await flagged(file, code), `${file}: ${code}`).not.toEqual([]);
  });

  it('is not tied to one spelling: the names are matched as identifiers, strings and templates', async () => {
    for (const code of ['x.wasmPaths', "x['wasmPaths']", 'x[`wasmBinary`]', '({ wasmBinary })']) {
      expect(await flagged('src/result/app.ts', code), code).not.toEqual([]);
    }
  });

  it('lets src/result/model.ts do exactly what it does today', async () => {
    const code = [
      "import * as ort from 'onnxruntime-web/wasm';",
      "ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');",
      'ort.env.wasm.numThreads = 1;',
    ].join('\n');
    expect(await flagged('src/result/model.ts', code)).toEqual([]);
  });

  it('still applies every other src rule to src/result/model.ts', async () => {
    for (const code of [
      "eval('1');",
      'WebAssembly.compile(bytes);',
      "document.createElement('script');",
    ]) {
      expect(await flagged('src/result/model.ts', code), code).not.toEqual([]);
    }
  });

  it('does not touch ordinary code that merely looks similar', async () => {
    const code = [
      'const environment = 1;',
      'const wasmPathsCount = 2;',
      "const label = 'environment';",
      'const o = { envelope: 1, binary: 2 };',
    ].join('\n');
    expect(await flagged('src/result/app.ts', code)).toEqual([]);
  });
});
