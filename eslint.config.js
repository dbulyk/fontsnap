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
const GLOBAL_OBJECTS = '/^(globalThis|self|window)$/';
// the objects whose members must not be written, however the write is spelled
const HOST_OBJECTS =
  '/^(globalThis|self|window|chrome|navigator|performance|crypto|fetch|Object|Reflect|JSON|Math|Promise|Array|Function|Response|Request|Headers|URL|Blob|XMLHttpRequest|WebSocket|EventSource)$/';
// the only properties of the global object that src/ reads
const READABLE_GLOBALS =
  '/^(crossOriginIsolated|crypto|devicePixelRatio|setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame)$/';
// the primitives that change properties, prototypes or what an object is
const TAMPER_NAMES =
  '/^(defineProperty|defineProperties|setPrototypeOf|getPrototypeOf|getOwnPropertyDescriptors|__proto__|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__|prototype|Proxy|Reflect)$/';
const TAMPER_MESSAGE =
  'No writing to global objects, host objects or prototypes, and no defineProperty/Reflect/Proxy/setPrototypeOf/__proto__/prototype in src/: replacing fetch, WebAssembly or a prototype would load code or bytes the build never checked.';
const globalTampering = [
  // a global object used as anything but `globalThis.<name>`: aliased, passed on, spread, computed, `with`
  `Identifier[name=${GLOBAL_OBJECTS}]:not(MemberExpression[computed=false] > Identifier.object):not(CallExpression[callee.name='startSelection'] > Identifier)`,
  `MemberExpression[computed=true][object.name=${GLOBAL_OBJECTS}]`,
  `MemberExpression[computed=false][object.name=${GLOBAL_OBJECTS}]:not([property.name=${READABLE_GLOBALS}])`,
  // a write whose target is rooted at a global or host object: assignment, update, delete, destructuring
  `AssignmentExpression > Identifier.left[name=${HOST_OBJECTS}]`,
  `AssignmentExpression > .left Identifier[name=${HOST_OBJECTS}]`,
  `UpdateExpression > .argument Identifier[name=${HOST_OBJECTS}]`,
  `UnaryExpression[operator='delete'] Identifier[name=${HOST_OBJECTS}]`,
  // Object.assign(<host object or a member of it>, ...) is a write to it (the first argument is the target)
  `CallExpression[callee.object.name='Object'][callee.property.name='assign']:matches([arguments.0.name=${HOST_OBJECTS}], [arguments.0.object.name=${HOST_OBJECTS}], [arguments.0.object.object.name=${HOST_OBJECTS}], [arguments.0.object.object.object.name=${HOST_OBJECTS}])`,
  // the primitives, by name, as identifiers, strings and templates
  `Identifier[name=${TAMPER_NAMES}]`,
  `Literal[value=${TAMPER_NAMES}]`,
  `TemplateLiteral[quasis.length=1][quasis.0.value.cooked=${TAMPER_NAMES}]`,
].map((selector) => ({ selector, message: TAMPER_MESSAGE }));

// --- what src/ may reach of the environment: an ALLOWLIST (review round 3 of PR #6) ---------------------------------
// Denying the ways to get at the global object (globalThis, window, top, document.defaultView, ...) and to write to it
// (assignment, defineProperty, Object.assign, Reflect, ...) was a list the reviewer completed three times. So the
// question is turned around: a global that is not named here cannot be used in src/ at all, and the ones that can be
// used only through the members named here (`[]`-style entries: '' = the bare name, 'a.b' = a path); a write to any of
// them, an alias, a destructuring, a computed access or passing one on is an error. What src/ really uses was read from
// the code; adding a line here is a decision about what the extension may touch, like a permission.
// Per file: only what that file needs (the Window of a content script, btoa for the screenshot, the one performance read).
const GLOBAL_ACCESS = {
  globals: {
    Array: ['', 'isArray'],
    Date: ['now'],
    Error: true,
    Float32Array: true,
    Float64Array: true,
    Infinity: true,
    Int32Array: true,
    Map: true,
    Math: true,
    NaN: true,
    Number: ['', 'isFinite'],
    Object: ['hasOwn', 'entries'],
    Promise: true,
    RangeError: true,
    Set: true,
    String: [''],
    URLSearchParams: true,
    Uint8Array: true,
    Uint8ClampedArray: true,
    chrome: [
      'action.getUserSettings',
      'action.onClicked',
      'action.onUserSettingsChanged',
      'contextMenus.create',
      'contextMenus.onClicked',
      'contextMenus.removeAll',
      'i18n.getMessage',
      'i18n.getUILanguage',
      'runtime.getURL',
      'runtime.id',
      'runtime.onInstalled',
      'runtime.onMessage',
      'runtime.sendMessage',
      'scripting.executeScript',
      'storage.session',
      'tabs.captureVisibleTab',
      'tabs.create',
      'tabs.sendMessage',
    ],
    clearInterval: true,
    createImageBitmap: true,
    document: true,
    encodeURIComponent: true,
    navigator: ['clipboard.writeText', 'hardwareConcurrency'],
    NodeFilter: true,
    OffscreenCanvas: true,
    requestAnimationFrame: true,
    setInterval: true,
    setTimeout: true,
    undefined: true,
  },
  files: {
    // the page of the selection overlay is a content script: its Window is the web page's, not the extension's
    'src/select/index.ts': { window: true },
    'src/select/overlay.ts': { Window: true, Object: ['assign'] },
    'src/background/shot.ts': {
      btoa: true,
      fetch: true,
      String: ['fromCharCode'],
      window: ['devicePixelRatio'],
    },
    'src/shared/capture.ts': { decodeURIComponent: true, globalThis: ['crypto'] },
    // data: URLs are decoded here instead of fetched (the CSP has connect-src 'self')
    'src/shared/data-url.ts': { Blob: true, Number: ['parseInt'], TypeError: true },
    // `'onUserSettingsChanged' in chrome.action`: older Chrome versions do not have the event
    'src/welcome/app.ts': { chrome: ['action'] },
    'src/result/model.ts': {
      fetch: true,
      globalThis: ['crossOriginIsolated'],
      Object: ['getOwnPropertyDescriptor'],
      performance: ['getEntriesByType'],
    },
  },
  // types through which a global scope is passed around
  types: [
    'Window',
    'WindowProxy',
    'MessageEventSource',
    'WorkerGlobalScope',
    'ServiceWorkerGlobalScope',
    'DedicatedWorkerGlobalScope',
  ],
};

/** Local rule: see GLOBAL_ACCESS. Plain JavaScript; exported so that tests can run it. */
export const globalAccessRule = {
  meta: { type: 'problem', schema: [{ type: 'object' }] },
  create(context) {
    const { globals, files, types } = context.options[0];
    const relative = context.filename
      .slice(context.cwd.length + 1)
      .split('\\')
      .join('/');
    const extra = Object.hasOwn(files, relative) ? files[relative] : {};
    const entryOf = (name) => {
      const own = Object.hasOwn(globals, name) ? globals[name] : undefined;
      const more = Object.hasOwn(extra, name) ? extra[name] : undefined;
      if (own === true || more === true) return true;
      if (own === undefined && more === undefined) return undefined;
      return [...(own ?? []), ...(more ?? [])];
    };
    const memberName = (node) => {
      if (!node.computed)
        return node.property.type === 'Identifier' ? node.property.name : undefined;
      if (node.property.type === 'Literal' && typeof node.property.value === 'string') {
        return node.property.value;
      }
      return undefined;
    };
    const through = (node) => {
      let outer = node;
      while (
        outer.parent &&
        ((outer.parent.type === 'MemberExpression' && outer.parent.object === outer) ||
          outer.parent.type === 'TSNonNullExpression' ||
          outer.parent.type === 'ChainExpression')
      ) {
        outer = outer.parent;
      }
      return outer;
    };
    const writes = (outer) => {
      const parent = outer.parent;
      switch (parent?.type) {
        case 'AssignmentExpression':
          return parent.left === outer;
        case 'UpdateExpression':
        case 'ArrayPattern':
        case 'RestElement':
          return true;
        case 'UnaryExpression':
          return parent.operator === 'delete';
        case 'ForInStatement':
        case 'ForOfStatement':
          return parent.left === outer;
        case 'AssignmentPattern':
          return parent.left === outer;
        case 'Property':
          return parent.parent.type === 'ObjectPattern' && parent.value === outer;
        default:
          return false;
      }
    };
    /** The members read from `identifier`, as a path: chrome.runtime.getURL -> ['runtime', 'getURL']; undefined if computed. */
    const pathOf = (identifier) => {
      const path = [];
      let node = identifier;
      for (;;) {
        const parent = node.parent;
        if (parent?.type === 'TSNonNullExpression' || parent?.type === 'ChainExpression') {
          node = parent;
        } else if (parent?.type === 'MemberExpression' && parent.object === node) {
          const name = memberName(parent);
          if (name === undefined) return { path, computed: true };
          path.push(name);
          node = parent;
        } else {
          return { path, computed: false };
        }
      }
    };
    const covered = (entry, path) =>
      entry.some((allowed) => {
        if (allowed === '') return path.length === 0;
        const wanted = allowed.split('.');
        return wanted.length <= path.length && wanted.every((name, index) => name === path[index]);
      });
    return {
      'Program:exit'() {
        const scope = context.sourceCode.scopeManager?.globalScope;
        if (!scope) return;
        const references = [
          ...scope.variables
            .filter((variable) => variable.defs.length === 0)
            .flatMap((v) => v.references),
          ...scope.through,
        ];
        for (const reference of references) {
          const { name } = reference.identifier;
          const entry = entryOf(name);
          const typeOnly = reference.isTypeReference && !reference.isValueReference;
          if (typeOnly) {
            if (types.includes(name) && entry === undefined) {
              context.report({
                node: reference.identifier,
                message: `The type ${name} carries a global scope around; it is not on the allowlist of src/ (GLOBAL_ACCESS in eslint.config.js).`,
              });
            }
            continue;
          }
          if (entry === undefined) {
            context.report({
              node: reference.identifier,
              message: `The global ${name} is not on the allowlist of src/ (GLOBAL_ACCESS in eslint.config.js): the extension reaches the environment only through the names and members listed there.`,
            });
            continue;
          }
          const outer = through(reference.identifier);
          if (writes(outer) || reference.isWrite()) {
            context.report({
              node: reference.identifier,
              message: `${name} is a global: src/ never writes to it or to anything below it.`,
            });
            continue;
          }
          if (entry === true) continue;
          const { path, computed } = pathOf(reference.identifier);
          if (computed || !covered(entry, path)) {
            context.report({
              node: reference.identifier,
              message: `${name}${path.map((member) => `.${member}`).join('')}${computed ? '[computed]' : ''} is not on the allowlist of src/ (GLOBAL_ACCESS in eslint.config.js): only ${entry.map((member) => (member === '' ? name : `${name}.${member}`)).join(', ')}.`,
            });
          }
        }
      },
    };
  },
};
export const fontsnapPlugin = { rules: { 'global-access': globalAccessRule } };
// Values that are a Window, or a stand-in for one, however they are reached: document.defaultView, iframe.contentWindow,
// event.view, message.source, event.currentTarget (the window an event was added to), getBackgroundPage(). GLOBAL_ACCESS closes
// the names `window`, `self`, `top`, `parent`, `frames`, `opener`; these are the properties that hand one over.
const REACH_NAMES = [
  'defaultView',
  'contentWindow',
  'view',
  'source',
  'opener',
  'currentTarget',
  'relatedTarget',
  'srcElement',
  'composedPath',
  'getBackgroundPage',
  'getViews',
  'parentWindow',
];
const REACH_MESSAGE =
  'No property that hands over a Window (defaultView, contentWindow, view, source, currentTarget, ...): a Window held in a variable can be passed to Object.assign, Reflect or defineProperty, and its fetch replaced.';
const reachSelectors = (names, except = '') => {
  const pattern = `/^(${names.join('|')})$/`;
  const not = except === '' ? '' : `:not(${except})`;
  return [
    `MemberExpression[computed=false][property.name=${pattern}]${not}`,
    `MemberExpression[computed=true]:matches([property.value=${pattern}], [property.quasis.0.value.cooked=${pattern}])${not}`,
    `Property[key.name=${pattern}]`,
    `Property[key.value=${pattern}]`,
    // event.target may be the Window an event was added to: it is only ever written (anchor.target = '_blank')
    "MemberExpression[computed=false][property.name='target']:not(AssignmentExpression > MemberExpression.left)",
    "ObjectPattern > Property[key.name='target']",
    // Object.assign is for styles only
    "CallExpression[callee.object.name='Object'][callee.property.name='assign']:not([arguments.0.property.name='style'])",
  ].map((selector) => ({ selector, message: REACH_MESSAGE }));
};
const reachDefault = reachSelectors(REACH_NAMES);
// The two page scripts that listen to the window (hashchange, pagehide): `const win = doc.defaultView;` is the one place
// a Window is held, and `win` is only ever used for `win.location` and `win.addEventListener`.
const PAGE_WINDOW_FILES = ['src/result/app.ts', 'src/welcome/app.ts'];
const reachPages = [
  ...reachSelectors(REACH_NAMES.filter((name) => name !== 'defaultView')),
  ...[
    "MemberExpression[computed=false][property.name='defaultView']:not(VariableDeclarator[id.name='win'] > MemberExpression.init)",
    "MemberExpression[computed=true]:matches([property.value='defaultView'], [property.quasis.0.value.cooked='defaultView'])",
    "Property[key.name='defaultView']",
    "Property[key.value='defaultView']",
    "Identifier[name='win']:not(MemberExpression[computed=false][property.name=/^(location|addEventListener)$/] > Identifier.object):not(VariableDeclarator > Identifier.id):not(UnaryExpression[operator='!'] > Identifier)",
  ].map((selector) => ({ selector, message: REACH_MESSAGE })),
];
const noInjectedCodeBase = [
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

  // Nothing in src/ writes to the global objects, to host objects or to prototypes (review of PR #6): onnxruntime-web
  // fetches its .wasm through the global fetch and compiles it with the global WebAssembly, so replacing either (or
  // Response.prototype, chrome.runtime.getURL, ...) loads other bytes with every other check green. The names assembled at
  // run time stay the accepted boundary of the template, but the global objects can not even be named in a way that
  // lets them be written: they are read as `globalThis.<allowed name>` only.
  ...globalTampering,
];
// FontSnap runs WebAssembly only through the files pinned in scripts/lib/vendor.ts. onnxruntime-web can be pointed at
// other code through its environment (env.wasm.wasmPaths: another URL or a different .wasm; env.wasm.wasmBinary:
// other bytes), which no build check sees. So the runtime is imported and configured in ONE file,
// src/result/model.ts, whose assignments a unit test pins; everywhere else in src/ the names are refused as
// identifiers, strings and templates (the names assembled at run time are the accepted boundary of this template),
// together with `env` (the way to reach them) and any import of onnxruntime-*.
const ORT_NAMES = '/^(env|wasmPaths|wasmBinary)$/';
const ORT_MESSAGE =
  'onnxruntime-web is imported and configured only in src/result/model.ts (env.wasm.wasmPaths / wasmBinary can run WebAssembly other than the pinned files of scripts/lib/vendor.ts).';
const ortConfinement = [
  `Identifier[name=${ORT_NAMES}]`,
  `Literal[value=${ORT_NAMES}]`,
  `TemplateLiteral[quasis.length=1][quasis.0.value.cooked=${ORT_NAMES}]`,
  'ImportDeclaration[source.value=/^onnxruntime-/]',
  'ExportAllDeclaration[source.value=/^onnxruntime-/]',
  'ExportNamedDeclaration[source.value=/^onnxruntime-/]',
].map((selector) => ({ selector, message: ORT_MESSAGE }));
const noInjectedCode = [...noInjectedCodeBase, ...ortConfinement];
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
    ignores: ['src/shared/format.ts', 'src/**/*.d.ts', ...PAGE_WINDOW_FILES],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachDefault,
      ],
    },
  },
  {
    // Two page scripts hold the Window of their page (hashchange, pagehide), under the narrow form of reachPages.
    files: PAGE_WINDOW_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachPages,
      ],
    },
  },
  {
    // Which globals and which of their members src/ may touch: an allowlist, see GLOBAL_ACCESS.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.d.ts'],
    plugins: { fontsnap: fontsnapPlugin },
    rules: { 'fontsnap/global-access': ['error', GLOBAL_ACCESS] },
  },
  {
    // The one file that configures onnxruntime-web: every other src rule applies to it.
    files: ['src/result/model.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCodeBase,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachDefault,
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
        ...reachDefault,
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
