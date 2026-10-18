import { readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import eslint from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import playwright from 'eslint-plugin-playwright';
import tseslint from 'typescript-eslint';
import ts from 'typescript';

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
  '/^(crossOriginIsolated|crypto|devicePixelRatio|innerWidth|innerHeight|setTimeout|clearTimeout|setInterval|clearInterval|requestAnimationFrame)$/';
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
  // `this` of an ordinary function is the global object when it is called as a callback (setTimeout(function () { this... })):
  // allowed only in a class constructor (always called with new), not in a function nested in it, and never as a parameter
  "ThisExpression:not(MethodDefinition[kind='constructor'] ThisExpression)",
  "MethodDefinition[kind='constructor'] > FunctionExpression :matches(FunctionExpression, FunctionDeclaration) ThisExpression",
  "Identifier[name='this']",
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
// --- code that runs in the web page's process (the content script, and the function chrome.scripting injects) ----------------
// The CSP of the extension does not apply there, so Window, and any object that leads to it, must not be reachable from this code
// at all - not by a name (`win`), not by a computed key (`doc[['default', 'View'].join('')]`), not through a cast, an event, a
// parameter that was renamed. Review round 5 of PR #6 found four such ways past a rule that looked for the name `win`; the class is
// closed instead (PAGE_PROCESS_GLOBS): the first parameter of `startSelection` - whatever it is called - is the one Window, and it
// is used through the members below (read or called; only the marker is written); in these files there is no computed access, no
// cast, no `for...in`, no `typeof x` or `T[K]` type, no `Object.*` but `Object.assign(el.style, ...)`, and only `div` elements.
const OVERLAY_FILE = 'src/select/overlay.ts';
const OVERLAY_WINDOW_MEMBERS = [
  'document',
  'addEventListener',
  'removeEventListener',
  'getSelection',
  'requestAnimationFrame',
  'devicePixelRatio',
];
/** Written by the overlay: the marker of a window that already shows it (declared in src/env.d.ts). */
const OVERLAY_WINDOW_WRITTEN = ['__fontsnapActive'];
// By GLOB, not by a list of files (review round 6 of PR #6: a module outside a hand-kept list, src/shared/page-probe.ts, was handed
// `doc` or an event by the overlay and reached the Window with a cast and a key built at run time): everything in src/select is
// held to these rules, a new file there too, and the code of src/select imports no value from anywhere else (selectImportSelectors),
// so nothing outside the folder gets into select.js. tests/unit/select-bundle.test.ts reads the real bundle to prove it.
const PAGE_PROCESS_GLOBS = [
  'src/select/**/*.ts',
  'src/background/measure.ts',
  'src/background/load-image.ts',
];
const MEASURE_FILE = 'src/background/measure.ts';
// The function that loads the clicked image in its own frame: the one file with an exception to "nothing that loads" (see below).
const LOAD_IMAGE_FILE = 'src/background/load-image.ts';
const LOAD_IMAGE_FUNCTION = 'loadImagePixels';

// --- every member of every DOM object the page code touches: an ALLOWLIST by type (review round 8 of PR #6) -------------------------
// Rounds 6, 7 and 8 each found a new way for the code of the page to reach the network through a DOM object (a style written
// through the result of Object.assign, createElementNS('style'), createAttribute('style'), an SVG <image> reached by a type
// predicate, <meta refresh>, `[im.src] = [u]`, ...). Lists of forbidden names were completed four times. So the rule is turned
// around like it was for `win`: the type checker tells which members belong to the DOM (those declared in lib.dom.d.ts), and in
// these files only the members named below may be used on ANY expression of a DOM type - however it was obtained (a parameter,
// a call result, a predicate, a destructuring) - and only the way named: r = read, c = call, w = write. A member that is not
// here (createElementNS, createAttribute, setAttributeNode*, querySelector*, ownerDocument, getRootNode, parentNode, host,
// click, href, src as a write, innerHTML, outerHTML, insertAdjacent*, namespaceURI, baseVal, dataset, attributes, animate,
// ...) is an error, as is a member of an `any`/`unknown` receiver and an index into a DOM collection. What the code of the page
// really uses, read from the code:
const DOM_MEMBERS = [
  {
    // the overlay: a few elements of its own, a range and a tree walker over the text, two mouse/keyboard events
    match: 'src/select/',
    members: {
      body: 'r',
      documentElement: 'r',
      isConnected: 'r',
      nodeValue: 'r',
      key: 'r',
      clientX: 'r',
      clientY: 'r',
      top: 'r',
      right: 'r',
      bottom: 'r',
      left: 'r',
      style: 'r',
      SHOW_TEXT: 'r',
      createElement: 'c',
      createRange: 'c',
      createTreeWalker: 'c',
      append: 'c',
      appendChild: 'c',
      remove: 'c',
      addEventListener: 'c',
      preventDefault: 'c',
      selectNodeContents: 'c',
      getBoundingClientRect: 'c',
      nextNode: 'c',
      toString: 'c',
      textContent: 'w',
    },
  },
  {
    // the function injected into the page: the images of the document, one image, its box
    match: MEASURE_FILE,
    members: {
      images: 'r',
      currentSrc: 'r',
      src: 'r',
      left: 'r',
      top: 'r',
      width: 'r',
      height: 'r',
      parentElement: 'r',
      scrollLeft: 'r',
      scrollTop: 'r',
      scrollTo: 'c',
      clientLeft: 'r',
      clientTop: 'r',
      clientWidth: 'r',
      clientHeight: 'r',
      getElementsByTagName: 'c',
      scrollIntoView: 'c',
      getBoundingClientRect: 'c',
    },
  },
  {
    // the function that loads the clicked image: the images of the document, one image and one canvas, the bytes of a blob. `src` is
    // written by `fromParameter` only (once, from the first parameter of loadImagePixels); `new Image()` is constructed once.
    match: LOAD_IMAGE_FILE,
    fromParameter: [{ member: 'src', fn: LOAD_IMAGE_FUNCTION }],
    once: ['Image'],
    members: {
      images: 'r',
      currentSrc: 'r',
      src: 'r',
      complete: 'r',
      naturalWidth: 'r',
      naturalHeight: 'r',
      width: 'r',
      height: 'r',
      crossOrigin: 'w',
      decode: 'c',
      getContext: 'c',
      drawImage: 'c',
      convertToBlob: 'c',
      arrayBuffer: 'c',
    },
  },
];
/** The two functions FontSnap hands to chrome.scripting.executeScript({ func }) (src/background/measure.ts, src/background/load-image.ts). */
const INJECTED_FUNCTIONS = ['measureImage', 'loadImagePixels'];

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
    // the timeout of a page script that does not answer (src/background/clicked.ts)
    clearTimeout: true,
    createImageBitmap: true,
    encodeURIComponent: true,
    navigator: ['clipboard.writeText', 'hardwareConcurrency'],
    NodeFilter: ['SHOW_TEXT'],
    OffscreenCanvas: true,
    setInterval: true,
    setTimeout: true,
    undefined: true,
  },
  files: {
    // the page of the selection overlay is a content script: its Window is the web page's, not the extension's
    // the window is only handed to startSelection(window) (a bare use: no member of it is read here)
    'src/select/index.ts': { window: [''] },
    'src/select/overlay.ts': { Object: ['assign'] },
    'src/background/shot.ts': { btoa: true, String: ['fromCharCode'] },
    // the function that chrome.scripting runs in the web page's process (see PAGE_PROCESS_GLOBS): the images of the page, its pixel ratio
    'src/background/measure.ts': {
      document: ['images', 'getElementsByTagName'],
      requestAnimationFrame: true,
      window: ['devicePixelRatio', 'innerWidth', 'innerHeight'],
    },
    // the function that loads the clicked image (see LOAD_IMAGE_FILE): one Image, a canvas, the bytes of the PNG as text
    'src/background/load-image.ts': {
      document: ['images'],
      Image: true,
      btoa: true,
      String: ['fromCharCode'],
    },
    // the entry scripts of the extension pages hand their document to the page script, and do nothing else with it
    'src/result/index.ts': { document: [''] },
    'src/welcome/index.ts': { document: [''] },
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
  // the Window handed to a function: the first parameter of this function (any name), used through these members only
  windowParams: {
    [OVERLAY_FILE]: {
      fn: 'startSelection',
      members: OVERLAY_WINDOW_MEMBERS,
      written: OVERLAY_WINDOW_WRITTEN,
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
    const { globals, files, types, windowParams } = context.options[0];
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
    const windowParam = Object.hasOwn(windowParams, relative) ? windowParams[relative] : undefined;
    /** The first parameter of the function that gets the Window, found by position, not by name. */
    const designated = () => {
      if (windowParam === undefined) return undefined;
      for (const statement of context.sourceCode.ast.body) {
        const declaration =
          statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
        if (
          declaration?.type === 'FunctionDeclaration' &&
          declaration.id?.name === windowParam.fn
        ) {
          const param = declaration.params[0];
          return param?.type === 'Identifier' ? { declaration, param } : undefined;
        }
      }
      return undefined;
    };
    const inside = (outer, node) =>
      node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1];
    /** Every use of the designated parameter: win.<member>, read or called; only the marker is written. */
    const checkWindowParam = (found) => {
      const variable = context.sourceCode
        .getDeclaredVariables(found.declaration)
        .find((candidate) =>
          candidate.defs.some((def) => def.type === 'Parameter' && def.name === found.param),
        );
      for (const reference of variable?.references ?? []) {
        const identifier = reference.identifier;
        const parent = identifier.parent;
        const name =
          parent?.type === 'MemberExpression' && parent.object === identifier
            ? memberName(parent)
            : undefined;
        const allowed = [...windowParam.members, ...windowParam.written];
        const outer = through(identifier);
        const writtenHere = writes(outer) || reference.isWrite();
        if (name === undefined || !allowed.includes(name)) {
          context.report({
            node: identifier,
            message: `The Window ${identifier.name} of ${windowParam.fn} is used only as ${identifier.name}.<${windowParam.members.join('|')}>, read or called (GLOBAL_ACCESS.windowParams in eslint.config.js): not aliased, cast, destructured, indexed by a computed key, reassigned or passed on - this code runs in the web page's process, outside the CSP of the extension.`,
          });
        } else if (writtenHere && !(outer === parent && windowParam.written.includes(name))) {
          context.report({
            node: identifier,
            message: `Only ${windowParam.written.join(', ')} of the Window may be written (${identifier.name}.${name} is not).`,
          });
        }
      }
    };
    return {
      'Program:exit'() {
        const scope = context.sourceCode.scopeManager?.globalScope;
        if (!scope) return;
        const found = designated();
        if (windowParam !== undefined) {
          if (found === undefined) {
            context.report({
              loc: { line: 1, column: 0 },
              message: `${windowParam.fn}(window) is missing: its first parameter is the one Window of ${relative} and the rule needs to find it.`,
            });
          } else {
            checkWindowParam(found);
          }
        }
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
            // the type Window only as the annotation of the designated parameter (not of any other parameter, variable, cast, generic)
            if (
              found !== undefined &&
              types.includes(name) &&
              inside(found.param, reference.identifier)
            ) {
              continue;
            }
            if (types.includes(name)) {
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
/**
 * Local rule (type-aware): the members of DOM objects in the code of the page, see DOM_MEMBERS. A member is a DOM member when its
 * symbol is declared in lib.dom.d.ts; Window is left to GLOBAL_ACCESS (windowParams, `window`).
 */
export const domMembersRule = {
  meta: { type: 'problem', schema: [{ type: 'array' }] },
  create(context) {
    const relative = context.filename
      .slice(context.cwd.length + 1)
      .split('\\')
      .join('/');
    const entry = context.options[0].find(
      (candidate) =>
        relative === candidate.match ||
        (candidate.match.endsWith('/') && relative.startsWith(candidate.match)),
    );
    if (entry === undefined) return {};
    const services = context.sourceCode.parserServices;
    if (services.program === undefined || services.program === null) {
      throw new Error('fontsnap/dom-members needs type information (parserOptions.project)');
    }
    const checker = services.program.getTypeChecker();
    const tsOf = (node) => services.esTreeNodeToTSNodeMap.get(node);
    const inDom = (declaration) =>
      /lib\.dom(\.[\w.]+)?\.d\.ts$/.test(declaration.getSourceFile().fileName);
    const constituents = (type) =>
      type.isUnionOrIntersection() ? type.types.flatMap(constituents) : [type];
    const isDomType = (type) =>
      constituents(type).some((one) => (one.symbol?.declarations ?? []).some(inDom));
    const isWindow = (type) => {
      const text = checker.typeToString(type);
      return (
        text === 'Window' || text === 'typeof globalThis' || text === 'Window & typeof globalThis'
      );
    };
    const kindOf = (node) => {
      let current = node;
      while (
        current.parent &&
        (current.parent.type === 'TSNonNullExpression' || current.parent.type === 'ChainExpression')
      ) {
        current = current.parent;
      }
      const parent = current.parent;
      switch (parent?.type) {
        case 'CallExpression':
          return parent.callee === current ? 'c' : 'r';
        case 'AssignmentExpression':
          return parent.left === current ? 'w' : 'r';
        case 'UpdateExpression':
        case 'ArrayPattern':
        case 'RestElement':
          return 'w';
        case 'UnaryExpression':
          return parent.operator === 'delete' ? 'd' : 'r';
        case 'ForInStatement':
        case 'ForOfStatement':
          return parent.left === current ? 'w' : 'r';
        case 'AssignmentPattern':
          return parent.left === current ? 'w' : 'r';
        case 'Property':
          return parent.parent.type === 'ObjectPattern' && parent.value === current ? 'w' : 'r';
        default:
          return 'r';
      }
    };
    const report = (node, text) => {
      context.report({ node, message: text });
    };
    // `x.<member> = <first parameter of fn>` as a statement of its own, in that function itself, once, and the parameter never
    // reassigned: the one way a page function may be given an address to load (entry.fromParameter)
    const fromParameter = entry.fromParameter ?? [];
    let parameterWrites = 0;
    const isParameterWrite = (node, fn) => {
      const assignment = node.parent;
      if (
        assignment?.type !== 'AssignmentExpression' ||
        assignment.operator !== '=' ||
        assignment.left !== node ||
        assignment.parent.type !== 'ExpressionStatement' ||
        assignment.right.type !== 'Identifier'
      ) {
        return false;
      }
      let scope = context.sourceCode.getScope(assignment);
      let variable;
      while (scope && variable === undefined) {
        variable = scope.set.get(assignment.right.name);
        scope = scope.upper;
      }
      const definition = variable?.defs[0];
      const declaration = definition?.node;
      if (
        definition?.type !== 'Parameter' ||
        declaration?.type !== 'FunctionDeclaration' ||
        declaration.id?.name !== fn ||
        declaration.params[0] !== definition.name ||
        !['Program', 'ExportNamedDeclaration'].includes(declaration.parent.type) ||
        variable.references.some((reference) => reference.isWrite() && reference.init !== true)
      ) {
        return false;
      }
      let outer = assignment.parent;
      while (outer && !/Function/.test(outer.type)) outer = outer.parent;
      return outer === declaration;
    };
    const constructed = new Map();
    return {
      NewExpression(node) {
        if (node.callee.type !== 'Identifier' || !(entry.once ?? []).includes(node.callee.name))
          return;
        const count = (constructed.get(node.callee.name) ?? 0) + 1;
        constructed.set(node.callee.name, count);
        if (count > 1)
          report(
            node,
            `new ${node.callee.name}() more than once in ${relative} (DOM_MEMBERS.once in eslint.config.js)`,
          );
      },
      MemberExpression(node) {
        const receiver = checker.getTypeAtLocation(tsOf(node.object));
        if (receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
          report(
            node,
            'A member of a value of unknown type (any/unknown) in the code of the web page: its type must be known to be checked (DOM_MEMBERS in eslint.config.js).',
          );
          return;
        }
        if (isWindow(receiver)) return;
        if (node.computed) {
          if (isDomType(receiver)) {
            report(
              node,
              'No indexing of a DOM object or collection in the code of the web page (DOM_MEMBERS in eslint.config.js).',
            );
          }
          return;
        }
        const name = node.property.name;
        const symbol = checker.getSymbolAtLocation(tsOf(node.property));
        const dom =
          symbol === undefined ? isDomType(receiver) : (symbol.declarations ?? []).some(inDom);
        if (!dom) return;
        const kind = kindOf(node);
        const allowed = Object.hasOwn(entry.members, name) ? entry.members[name] : '';
        const grant = kind === 'w' ? fromParameter.find((one) => one.member === name) : undefined;
        if (grant !== undefined && isParameterWrite(node, grant.fn)) {
          parameterWrites += 1;
          if (parameterWrites > 1) {
            report(
              node,
              `A second write of ${name} from the parameter of ${grant.fn}: one address is loaded, once (DOM_MEMBERS.fromParameter in eslint.config.js).`,
            );
          }
          return;
        }
        if (!allowed.includes(kind)) {
          report(
            node,
            `The DOM member ${name} (${{ r: 'read', c: 'call', w: 'write' }[kind]}) is not on the list for ${relative}: ${Object.entries(
              entry.members,
            )
              .map(([member, how]) => `${member}:${how}`)
              .join(
                ' ',
              )} (DOM_MEMBERS in eslint.config.js). A DOM object reaches the network through members like createElementNS, setAttributeNode, ownerDocument, href, innerHTML.`,
          );
        }
      },
      // the width of a box is a number and px, nothing else
      'CallExpression[callee.object.name="Object"][callee.property.name="assign"] > ObjectExpression > Property[key.name=/^(left|top|width|height)$/] > TemplateLiteral'(
        node,
      ) {
        const [first, second] = node.quasis;
        const [expression] = node.expressions;
        const numeric =
          expression !== undefined &&
          (checker.getTypeAtLocation(tsOf(expression)).flags & ts.TypeFlags.NumberLike) !== 0;
        if (
          node.expressions.length !== 1 ||
          first?.value.cooked !== '' ||
          second?.value.cooked !== 'px' ||
          !numeric
        ) {
          report(
            node,
            'left/top/width/height are a number and px, written `${number}px` (a template with one expression of type number), or a literal such as 0, auto, 12px, 50% (STYLE_KEYS in eslint.config.js).',
          );
        }
      },
    };
  },
};
// --- the code of the page has no types of its own (review round 9 of PR #6, r4308642691) ----------------------------------------------
// `dom-members` knows a DOM value by where the symbol of the member is declared. A DOM value handed to a variable, a parameter or a
// return of an `interface` or an object type of the code's own is no longer seen: the members of that type are free (`querySelector('a')`
// with `host` and `click()`, `createElementNS('style')`, in measure.ts `ownerDocument.createElementNS('style')`). Following every place
// a value can flow into such a type (an annotation, an argument, a return, `satisfies`, a default parameter, an array inferred from a
// literal, the parameter of a callback) is a list that grows with the language; so the class is closed where such a type is BORN. In the
// code of the page the only object types are library types (lib.*.d.ts), type parameters, and the names of this table: the interfaces
// that may be declared here, with the property names each may have, and the type names that may be imported (`import type`) with the
// file each must come from. Writing a type of its own is a deliberate edit of this table, like a permission.
const PAGE_TYPES = [
  {
    match: 'src/select/',
    // library types that ambient declarations add properties to (src/env.d.ts: the marker of the overlay; @types/chrome); the Window is
    // judged by GLOBAL_ACCESS
    augmented: ['Window'],
    interfaces: {},
    imports: {
      Rect: 'src/shared/capture.ts',
      RequestOf: 'src/shared/messages.ts',
      MessageKey: 'src/shared/i18n.ts',
    },
  },
  {
    match: MEASURE_FILE,
    augmented: [],
    interfaces: { MeasuredImage: ['rect', 'dpr', 'saved', 'box'] },
    imports: { Rect: 'src/shared/capture.ts' },
  },
  { match: LOAD_IMAGE_FILE, augmented: [], interfaces: {}, imports: {} },
];

/** Local rule (type-aware): see PAGE_TYPES. Plain JavaScript; exported so that tests can run it. */
export const pageTypesRule = {
  meta: { type: 'problem', schema: [{ type: 'array' }] },
  create(context) {
    const relative = context.filename
      .slice(context.cwd.length + 1)
      .split('\\')
      .join('/');
    const entry = context.options[0].find(
      (candidate) =>
        relative === candidate.match ||
        (candidate.match.endsWith('/') && relative.startsWith(candidate.match)),
    );
    if (entry === undefined) return {};
    const services = context.sourceCode.parserServices;
    if (services.program === undefined || services.program === null) {
      throw new Error('fontsnap/page-types needs type information (parserOptions.project)');
    }
    const { program } = services;
    const checker = program.getTypeChecker();
    const tsOf = (node) => services.esTreeNodeToTSNodeMap.get(node);
    const fileOf = (declaration) => declaration.getSourceFile().fileName.split('\\').join('/');
    const inLibrary = (declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile());
    const here = (declaration) => fileOf(declaration).endsWith(`/${relative}`);
    const comesFrom = (declaration, path) => fileOf(declaration).endsWith(`/${path}`);
    const listed = (table, name) => Object.hasOwn(table, name);
    // a library type, or one of the global types that ambient declarations (src/env.d.ts, @types/*) add properties to
    const library = (declaration, name) => inLibrary(declaration) || entry.augmented.includes(name);
    const report = (node, what) => {
      context.report({
        node,
        message: `${what}: the code that runs in the web page's process has no types of its own (PAGE_TYPES in eslint.config.js) - a DOM value typed by one is no longer checked by fontsnap/dom-members. Library types, type parameters and the listed names only.`,
      });
    };
    const declared = new Set();
    /** Is a type of a library, or of this table? Used for the contextual type of an object literal. */
    const acceptable = (type) => {
      if (type.isUnionOrIntersection()) return type.types.every(acceptable);
      if ((type.flags & ts.TypeFlags.Object) === 0) {
        return (type.flags & ts.TypeFlags.TypeParameter) === 0;
      }
      const declarations = type.symbol?.declarations ?? [];
      const name = type.symbol?.name ?? '';
      return (
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            library(declaration, name) ||
            (listed(entry.interfaces, name) && here(declaration)) ||
            Object.values(entry.imports).some((path) => comesFrom(declaration, path)),
        )
      );
    };
    return {
      TSInterfaceDeclaration(node) {
        const name = node.id.name;
        if (!listed(entry.interfaces, name) || declared.has(name)) {
          report(node, `The interface ${name} is not on the list (or is declared twice)`);
          return;
        }
        declared.add(name);
        const properties = entry.interfaces[name];
        if (node.extends.length > 0) report(node, `The interface ${name} extends another`);
        for (const member of node.body.body) {
          if (
            member.type !== 'TSPropertySignature' ||
            member.computed ||
            member.key.type !== 'Identifier' ||
            !properties.includes(member.key.name)
          ) {
            report(
              member,
              `A member of ${name} that is not a listed property (${properties.join(', ')})`,
            );
          }
        }
      },
      TSTypeLiteral(node) {
        report(node, 'A type literal');
      },
      TSMappedType(node) {
        report(node, 'A mapped type');
      },
      ClassDeclaration(node) {
        report(node, 'A class');
      },
      ClassExpression(node) {
        report(node, 'A class');
      },
      TSEnumDeclaration(node) {
        report(node, 'An enum');
      },
      TSTypeReference(node) {
        const leaf = node.typeName.type === 'TSQualifiedName' ? node.typeName.right : node.typeName;
        if (leaf.type === 'Identifier' && leaf.name === 'const') return; // `as const`
        const found = checker.getSymbolAtLocation(tsOf(leaf));
        const symbol =
          found !== undefined && (found.flags & ts.SymbolFlags.Alias) !== 0
            ? checker.getAliasedSymbol(found)
            : found;
        const declarations = symbol?.declarations ?? [];
        const name = leaf.name;
        const fine =
          symbol !== undefined &&
          ((symbol.flags & ts.SymbolFlags.TypeParameter) !== 0 ||
            (declarations.length > 0 &&
              declarations.every(
                (declaration) =>
                  library(declaration, name) ||
                  (listed(entry.interfaces, name) && here(declaration)) ||
                  (listed(entry.imports, name) && comesFrom(declaration, entry.imports[name])),
              )));
        if (!fine)
          report(node, `The type ${name} is not a library type, a type parameter or a listed name`);
      },
      ObjectExpression(node) {
        const parent = node.parent;
        if (
          parent.type === 'CallExpression' &&
          parent.callee.type === 'MemberExpression' &&
          parent.callee.object.type === 'Identifier' &&
          parent.callee.object.name === 'Object' &&
          parent.callee.property.type === 'Identifier' &&
          parent.callee.property.name === 'assign' &&
          parent.arguments[1] === node
        ) {
          return;
        }
        const contextual = checker.getContextualType(tsOf(node));
        if (contextual === undefined || !acceptable(contextual)) {
          report(
            node,
            'An object literal whose type is inferred, or is not a library or a listed type',
          );
        }
      },
    };
  },
};
export const fontsnapPlugin = {
  rules: {
    'global-access': globalAccessRule,
    'dom-members': domMembersRule,
    'page-types': pageTypesRule,
  },
};
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
// CSS that loads something, in a string (round 7 of the review of PR #6: a style built at run time, `['ur', 'l(', ...].join('')`, or
// written with a CSS escape, `u\\72 l(`, made the page request an image although no rule saw the word url). It is a pattern
// and a function in ONE place: the rule below (strings of the code of the page) and verify-dist (scripts/lib/wasm-scan.ts, which
// imports them) judge the same way. A CSS function that fetches (url, image-set, image, cross-fade, element, paint, src) not
// after a name character (so `getURL(` and `new URL(` are not CSS), and @import.
export const CSS_LOADING_SOURCE =
  '(?<![\\w$-])(?:url|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|-moz-element|paint|src)\\s*\\(|@import';
/** The text with its CSS escapes undone (`u\\72 l(` is `url(` to a style sheet). */
export function cssUnescape(text) {
  return text.replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^0-9a-f\n])/gi, (_all, hex, plain) =>
    hex === undefined ? plain : String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd),
  );
}
const PAGE_PROCESS_MESSAGE =
  "In the code that runs in the web page's process (src/select, src/background/measure.ts) the CSP of the extension does not apply: no computed access, no casts (as/<T>), no for...in, no typeof/indexed types, no Object.* but Object.assign(el.style, ...), only div elements, no way to load or navigate (src/href/innerHTML/setAttribute/url(...)). See PAGE_PROCESS_GLOBS in eslint.config.js.";
// what makes an element load something or navigate
const LOADING_NAMES =
  '/^(src|srcset|srcdoc|href|action|formAction|ping|poster|data|location|innerHTML|outerHTML|cssText|adoptedStyleSheets)$/';
const LOADING_CALLS =
  '/^(setAttribute|setAttributeNS|setAttributeNode|insertAdjacentHTML|insertAdjacentElement|insertRule|addRule|replaceSync|open|write|writeln|createContextualFragment|parseFromString|setHTMLUnsafe)$/';
// Imports of the code that runs in the web page's process: value imports only from src/select itself (a relative path of plain
// names below this folder, no extension, no `..`); anything else - another folder of src, a package, an absolute or aliased
// path, a `..` that finds its way back - only as `import type`, which leaves nothing in the bundle. The function of
// src/background/measure.ts is serialized by chrome.scripting, so it takes no value import at all.
const SELECT_SIBLING = '/^\\.\\x2f([\\w-]+\\x2f)*[\\w-]+$/';
const IMPORT_MESSAGE =
  "Code that runs in the web page's process imports values only from src/select (./name); other modules only as `import type` (they would be bundled into select.js, outside the rules of this code). See PAGE_PROCESS_GLOBS in eslint.config.js.";
const importSelectors = (valueFrom) =>
  [
    `ImportDeclaration:not([importKind='type'])${valueFrom}`,
    `ExportNamedDeclaration[source]:not([exportKind='type'])${valueFrom}`,
    `ExportAllDeclaration:not([exportKind='type'])${valueFrom}`,
    'TSImportEqualsDeclaration',
    'TSExportAssignment',
  ].map((selector) => ({ selector, message: IMPORT_MESSAGE }));
const selectImportSelectors = importSelectors(`:not([source.value=${SELECT_SIBLING}])`);
const measureImportSelectors = importSelectors('');
const pageProcessSelectorSources = [
  // no key that is computed at run time (a numeric index is fine), in access, destructuring, literals, classes
  "MemberExpression[computed=true]:not([property.type='Literal'][property.raw=/^[0-9]+$/])",
  'Property[computed=true]',
  'MethodDefinition[computed=true]',
  'PropertyDefinition[computed=true]',
  // no casts: `x as unknown as Record<...>` made a Window out of a Document
  "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])",
  'TSTypeAssertion',
  // nothing that enumerates, nothing that names a type from a value or from a key
  'ForInStatement',
  'WithStatement',
  // a spread of an object (an event, a node) copies what it enumerates; only arrays are spread here
  'ObjectExpression > SpreadElement',
  'CallExpression > SpreadElement',
  'NewExpression > SpreadElement',
  'TSIndexedAccessType',
  'TSTypeQuery',
  'TSIndexSignature',
  'TSTypeReference[typeName.name=/^(Record|Object|Function|Proxy|ProxyHandler|PropertyKey)$/]',
  // Object only as Object.assign(el.style, ...) (the rule above); never as a value or with another member
  "MemberExpression[object.name='Object']:not([property.name='assign'])",
  "Identifier[name='Object']:not(MemberExpression[computed=false] > Identifier.object)",
  // elements: div only; nothing that loads or navigates
  "CallExpression[callee.property.name='createElement']:not([arguments.0.type='Literal'][arguments.0.value='div'])",
  `AssignmentExpression > MemberExpression.left[property.name=${LOADING_NAMES}]`,
  `CallExpression[callee.property.name=${LOADING_CALLS}]`,
  `Property[key.name=${LOADING_NAMES}]`,
  // strings: nothing that loads (CSS_LOADING_SOURCE), and no backslash at all (a CSS escape hides `url(`; JS escapes like \n are no backslash)
  `Literal[value=/${CSS_LOADING_SOURCE}|expression\\s*\\(|javascript:/i]`,
  `TemplateElement[value.cooked=/${CSS_LOADING_SOURCE}|expression\\s*\\(|javascript:/i]`,
  'Literal[value=/\\x5c/]',
  'TemplateElement[value.cooked=/\\x5c/]',
  // import.meta (Vite turns import.meta.glob into static imports)
  'MetaProperty',
  // a type predicate or an assertion function is a cast without `as` (round 8: `(e): e is SVGImageElement`); an overload signature
  // is another (the implementation is looser than the signature)
  'TSTypePredicate',
  'TSEmptyBodyFunctionExpression',
  // no object destructuring at all: `const { ownerDocument } = el` takes a member without naming it as an access
  'ObjectPattern',
  // a member as the TARGET of a destructuring or a loop writes to it like an assignment does: `[im.src] = [u]`, `for (im.src of [u])`
  'ArrayPattern > MemberExpression',
  'RestElement > MemberExpression',
  'AssignmentPattern > MemberExpression.left',
  'ObjectPattern > Property > MemberExpression.value',
  'ForOfStatement > MemberExpression.left',
  'ForInStatement > MemberExpression.left',
  // elements: createElement('div') and nothing else, no second argument (`{ is }`)
  "CallExpression[callee.property.name='createElement']:not([arguments.length=1])",
];
const pageProcessSelectors = pageProcessSelectorSources.map((selector) => ({
  selector,
  message: PAGE_PROCESS_MESSAGE,
}));
// loadImagePixels (LOAD_IMAGE_FILE) is the one page function that may load an address: the write of `src` is allowed here and judged by
// fontsnap/dom-members (DOM_MEMBERS.fromParameter: once, from the first parameter, nothing else); `new Image()` is the only use of
// Image, without arguments, and its crossOrigin is the literal 'anonymous' (a request without credentials).
const LOADING_WRITE = `AssignmentExpression > MemberExpression.left[property.name=${LOADING_NAMES}]`;
const LOAD_IMAGE_MESSAGE = `${PAGE_PROCESS_MESSAGE} The one exception is src/background/load-image.ts: new Image() (no arguments), crossOrigin = 'anonymous' and a single src = <its first parameter>.`;
const loadImageSelectors = [
  ...pageProcessSelectorSources.map((selector) =>
    selector === LOADING_WRITE ? `${LOADING_WRITE}:not([property.name='src'])` : selector,
  ),
  // the loader is never called, not even by itself (it could hand itself another address) and not taken as a value
  `Identifier[name='${LOAD_IMAGE_FUNCTION}']:not(FunctionDeclaration > Identifier.id)`,
  "NewExpression[callee.name='Image']:not([arguments.length=0])",
  "Identifier[name='Image']:not(NewExpression > Identifier.callee)",
  "AssignmentExpression[left.property.name='crossOrigin']:not([right.type='Literal'][right.value='anonymous'])",
  "AssignmentExpression[left.property.name='crossOrigin']:not([operator='='])",
].map((selector) => ({ selector, message: LOAD_IMAGE_MESSAGE }));

// --- style of the code that runs in the web page (review round 7 of PR #6, blocker E) -------------------------------------------
// A style can load a file: `box.style.backgroundImage = 'url(...)'`, with the string built at run time or written with a CSS escape.
// So style is written in ONE way only, `Object.assign(<el>.style, { key: value, ... })`, with the keys the overlay uses and nothing
// else (no spread, no computed or string key, no method). Of those keys only `cursor` and `background` accept a url(): their value
// is a string literal that is a keyword, a hex colour or rgb()/rgba() of numbers - nothing else. The others cannot hold a url() by
// their grammar; they take string literals too, and left/top/width/height a literal or a template (`${x}px`). Everything else about
// style is refused: .style as a value or an alias, setProperty, cssText, attributeStyleMap, adoptedStyleSheets, insertRule,
// animate (keyframes can carry a url), setAttribute('style'), createElement('style' | 'link') (div only).
const STYLE_KEYS = [
  'position',
  'inset',
  'zIndex',
  'cursor',
  'background',
  'border',
  'display',
  'pointerEvents',
  'top',
  'left',
  'width',
  'height',
  'transform',
  'color',
  'font',
  'padding',
  'borderRadius',
];
const STYLE_MESSAGE =
  "Style of the code that runs in the web page's process is written only as Object.assign(<el>.style, { key: value }) with the keys listed as STYLE_KEYS in eslint.config.js; `cursor` and `background` take a keyword, a hex colour or rgb()/rgba() written as a string literal, left/top/width/height a literal or a template, the others a string literal (a style can load a file with url(), and this code is outside the CSP of the extension).";
const ASSIGN = "CallExpression[callee.object.name='Object'][callee.property.name='assign']";
const URL_KEYS = '/^(cursor|background)$/';
const SAFE_URL_KEY_VALUE = '/^(?:[a-z-]+|\\x23[0-9a-f]{3,8}|rgba?\\([0-9., %]+\\))$/i';
const STYLE_NAMES =
  '/^(setProperty|removeProperty|getPropertyValue|cssText|attributeStyleMap|computedStyleMap|styleSheets|adoptedStyleSheets|sheet|animate|Animation|KeyframeEffect|CSSStyleSheet|attributes|getAttributeNode|setNamedItem|getComputedStyle)$/';
const styleObject = `${ASSIGN} > ObjectExpression`;
const styleSelectors = [
  // Object.assign(el.style, { ... }) is a statement of its own: its result - the style declaration itself - is never kept, passed
  // on or returned (round 8: `const s = Object.assign(el.style, {}); s.backgroundImage = ...`); Object.assign is only ever called, at
  // once (no alias, no .call/.apply/.bind, no `{ assign } = Object`); no object literal has a `style` key (`{ style: 'background:url(x)' }`)
  `${ASSIGN}:not(ExpressionStatement > CallExpression)`,
  "MemberExpression[object.name='Object'][property.name='assign']:not(CallExpression > MemberExpression.callee)",
  "Property[key.name='style']",
  // left/top/width/height: 0, auto, a length or a percentage as a literal (or `${number}px`, checked by fontsnap/dom-members)
  "Property[key.name=/^(left|top|width|height)$/][value.type='Literal']:not([value.value=/^(?:0|auto|-?[0-9]+(?:[.][0-9]+)?(?:px|%))$/])",
  // style appears only as the first argument of Object.assign
  `MemberExpression[property.name='style']:not(${ASSIGN} > MemberExpression.arguments:first-child)`,
  "ObjectPattern > Property[key.name='style']",
  "Property[key.value='style']",
  `Identifier[name=${STYLE_NAMES}]`,
  `Literal[value=${STYLE_NAMES}]`,
  // Object.assign(el.style, { ... }): exactly two arguments, the second an object literal of plain `key: value` properties
  `${ASSIGN}:not([arguments.length=2])`,
  `${ASSIGN}:not([arguments.1.type='ObjectExpression'])`,
  `${styleObject} > SpreadElement`,
  `${styleObject} > Property:not([kind='init'])`,
  `${styleObject} > Property[method=true]`,
  `${styleObject} > Property[computed=true]`,
  `${styleObject} > Property[shorthand=true]`,
  `${styleObject} > Property:not([key.type='Identifier'])`,
  `${styleObject} > Property[key.type='Identifier']:not([key.name=/^(${STYLE_KEYS.join('|')})$/])`,
  // values
  `${styleObject} > Property[key.name=${URL_KEYS}]:not([value.type='Literal'])`,
  `${styleObject} > Property[key.name=${URL_KEYS}][value.type='Literal']:not([value.value=${SAFE_URL_KEY_VALUE}])`,
  `${styleObject} > Property:not([key.name=/^(left|top|width|height)$/]):not([value.type='Literal'])`,
  `${styleObject} > Property[key.name=/^(left|top|width|height)$/]:not([value.type=/^(Literal|TemplateLiteral)$/])`,
  `${styleObject} > Property[value.type='Literal']:not([value.raw=/^['"]/])`,
].map((selector) => ({ selector, message: STYLE_MESSAGE }));
// the injected function writes no style at all
const noStyleSelectors = [
  "MemberExpression[property.name='style']",
  "Property[key.name='style']",
  "Identifier[name='Object']",
  `Identifier[name=${STYLE_NAMES}]`,
].map((selector) => ({
  selector,
  message:
    'The function that chrome.scripting injects into the page writes no style and uses no Object (src/background/measure.ts): a style can load a file with url(), outside the CSP of the extension.',
}));

// The one function that may be injected into a page with chrome.scripting.executeScript, and in no other world than the isolated one.
const INJECTION_MESSAGE = `chrome.scripting.executeScript is called directly, with an object literal whose func is one of ${INJECTED_FUNCTIONS.join(', ')} (src/background/measure.ts and load-image.ts, held to the rules of the content script) or a files list, and no world: any other function would run in the web page's process outside the CSP of the extension.`;
const EXECUTE = "CallExpression[callee.property.name='executeScript']";
const injectionSelectors = [
  "MemberExpression[property.name='executeScript']:not(CallExpression > MemberExpression.callee)",
  `${EXECUTE}:not([arguments.0.type='ObjectExpression'])`,
  `${EXECUTE} > ObjectExpression > SpreadElement`,
  `${EXECUTE} > ObjectExpression > Property[computed=true]`,
  `${EXECUTE} > ObjectExpression > Property:matches([key.name='func'], [key.value='func']):not([value.type='Identifier'][value.name=/^(${INJECTED_FUNCTIONS.join('|')})$/])`,
  `${EXECUTE} > ObjectExpression > Property:matches([key.name='world'], [key.value='world'])`,
].map((selector) => ({ selector, message: INJECTION_MESSAGE }));

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
  ...injectionSelectors,
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
    ignores: ['src/shared/format.ts', 'src/**/*.d.ts', ...PAGE_WINDOW_FILES, ...PAGE_PROCESS_GLOBS],
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
    // The code that runs in the web page's process: the Window of the page only through the first parameter of startSelection
    // (GLOBAL_ACCESS.windowParams), and the rules of pageProcessSelectors.
    files: ['src/select/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachDefault,
        ...pageProcessSelectors,
        ...styleSelectors,
        ...selectImportSelectors,
      ],
    },
  },
  {
    // The function chrome.scripting serializes into the page: no import of a value at all.
    files: [MEASURE_FILE],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachDefault,
        ...pageProcessSelectors,
        ...noStyleSelectors,
        ...measureImportSelectors,
      ],
    },
  },
  {
    // The function that loads the clicked image in its own frame: the rules of the content script but for the narrow exception above.
    files: [LOAD_IMAGE_FILE],
    rules: {
      'no-restricted-syntax': [
        'error',
        noDynamicImport,
        ...noRequireOrDeclare,
        ...noInjectedCode,
        ...noDynamicIn,
        ...numbersAndText,
        ...reachDefault,
        ...loadImageSelectors,
        ...noStyleSelectors,
        ...measureImportSelectors,
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
    // The members of every DOM object in the code of the web page: an allowlist by type, see DOM_MEMBERS.
    files: PAGE_PROCESS_GLOBS,
    rules: {
      'fontsnap/dom-members': ['error', DOM_MEMBERS],
      'fontsnap/page-types': ['error', PAGE_TYPES],
    },
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
