import ts from 'typescript';
import { CSS_LOADING_SOURCE, cssUnescape } from '../../eslint.config.js';

/**
 * WebAssembly other than the pinned vendor files could reach the extension inside a built script, past every check
 * of the build: as the bytes of a module (a literal, base64, hex, an escape, a list of numbers) or through the
 * settings of onnxruntime-web that name other code (`wasmPaths`: another URL; `wasmBinary`: other bytes). This is the
 * check of the built files for both; the sources are guarded by eslint.config.js and tests/unit/model.test.ts.
 * The vendor files themselves are exempt by exact path AND sha256 (vendor.ts), never by prefix.
 */

/** The header of every module: 00 61 73 6d ("\0asm") followed by the version 01 00 00 00. */
const HEADER_BYTES = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

/**
 * What base64 looks like when a module header sits at any alignment of the encoded bytes (the encoding of the same
 * bytes depends on the position modulo 3, and the characters next to the header depend on its neighbours). The parts that
 * do not depend on the neighbours are found by encoding the header with 0x00 and with 0xff around it and keeping the longest
 * run of characters that agree: AGFzbQEAAA, Bhc20BAAAA, AYXNtAQAAA... (base64url differs only in two characters that these
 * do not contain).
 */
function base64Signatures(): string[] {
  return [0, 1, 2].map((before) => {
    const encode = (filler: number) =>
      Buffer.from([
        ...Array<number>(before).fill(filler),
        ...HEADER_BYTES,
        ...Array<number>(3).fill(filler),
      ]).toString('base64');
    const [low, high] = [encode(0x00), encode(0xff)];
    let best = '';
    let run = '';
    for (let i = 0; i < low.length; i++) {
      run = low[i] === high[i] ? run + (low[i] ?? '') : '';
      if (run.length > best.length) best = run;
    }
    return best;
  });
}
const BASE64_HEADERS = base64Signatures();

/** The text of every string literal in a script, in the forms a program can read it: as written, with escapes and %-escapes decoded. */
function stringForms(text: string): string[] {
  const forms: string[] = [];
  const literals = /"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`/g;
  for (const literal of text.match(literals) ?? []) {
    let form = literal.slice(1, -1);
    forms.push(form);
    form = form.replace(
      /\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|u\{([0-9a-f]+)\})/gi,
      (_all, x: string | undefined, u: string | undefined, braces: string | undefined) =>
        String.fromCodePoint(Number.parseInt(x ?? u ?? braces ?? '0', 16)),
    );
    forms.push(form);
    // %-escapes, also doubly encoded
    for (let round = 0; round < 3; round++) {
      const decoded = form.replace(/%([0-9a-f]{2})/gi, (_all, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
      if (decoded === form) break;
      form = decoded;
      forms.push(form);
    }
  }
  return forms;
}

const HEADER = [
  { pattern: /\0asm/, spelling: 'the raw bytes \\0asm' },
  { pattern: /\\(?:x0{2}|u0{4}|u\{0+\}|0{1,3})asm/i, spelling: 'an escape of \\0asm' },
  { pattern: /0061736d/i, spelling: 'hex (0061736d)' },
  {
    // 0, 97, 115, 109 in any radix: decimal, 0x61, 0b1100001, 0o141
    pattern:
      /(?<![\w.])(?:0|0x0+|0b0+|0o0+)\s*,\s*(?:97|0x61|0b1100001|0o141)\s*,\s*(?:115|0x73|0b1110011|0o163)\s*,\s*(?:109|0x6d|0b1101101|0o155)(?![\w.])/i,
    spelling: 'the byte list 0,97,115,109',
  },
];

/** The ways a text spells the header of a WebAssembly module, or names a .wasm file in a string; empty if none. */
export function wasmSignatures(text: string): string[] {
  const found = HEADER.filter(({ pattern }) => pattern.test(text)).map(({ spelling }) => spelling);
  if (BASE64_HEADERS.some((signature) => text.includes(signature)))
    found.push('base64 of a module header');
  // a file name, in a string literal as written or decoded: ".wasm" at the end (or before a query or fragment)
  if (stringForms(text).some((form) => /\.wasm(?:[?#]|$)/i.test(form)))
    found.push('a reference to a .wasm file');
  return found;
}

/** The only hosts a script of the build may name: the Google Fonts previews and links of the result page. */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'fonts.googleapis.com',
  'fonts.google.com',
]);

const URL_IN_TEXT =
  /(?:^|[^A-Za-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/\s@]*@)?([^/\s:"'`?#\\@]+)/gi;
const originsIn = (form: string): string[] =>
  [...form.matchAll(URL_IN_TEXT)].map((match) => (match[1] ?? '').toLowerCase());

/** Hosts of the absolute and protocol-relative URLs that the string literals of a script spell (any scheme, escapes and %-escapes decoded). */
export function urlOrigins(text: string): string[] {
  const hosts = new Set<string>();
  for (const form of stringForms(text)) for (const host of originsIn(form)) hosts.add(host);
  return [...hosts].sort();
}

/**
 * Servers of WebRTC are named with the schemes `stun:`, `turn:` and `turns:`, which carry no `//` and so are no URL for urlOrigins
 * (round 5 of the review of PR #6, found by the tester: `new RTCPeerConnection({ iceServers: [{ urls: 'stun:example.invalid:3478' }] })`
 * left the page for the internet through the lint-clean build). No script of the build names one, in any case, in a string as
 * written or with its escapes decoded (a name split across a concatenation is folded by terser into one literal, and RTCPeerConnection
 * itself is a forbidden name besides).
 */
export function iceServerSchemes(text: string): string[] {
  const found = new Set<string>();
  for (const form of stringForms(text)) {
    for (const match of form.matchAll(/(?:^|[^a-z0-9+.-])(stuns?|turns?):/gi)) {
      found.add((match[1] ?? '').toLowerCase());
    }
  }
  return [...found].sort();
}

/**
 * Text that is not written as a URL or a file name but decodes to one (review round 3 of PR #6: `atob('aHR0cHM6Ly9ldmls...')`
 * and `.wasm` in base64 were invisible): the base64 / base64url (at every alignment of the four-character groups), hex and
 * byte-number-list forms of what a string literal or an array holds. Returns what each decodes to when that is a module
 * header, a `.wasm` name or a URL on a host that is not allowed.
 */
export function hiddenTexts(text: string): string[] {
  const decoded: string[] = [];
  for (const form of stringForms(text)) {
    for (const token of form.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []) {
      const standard = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      for (let skip = 0; skip < 4; skip++) {
        const part = standard.slice(skip);
        if (part.length >= 8) decoded.push(Buffer.from(part, 'base64').toString('latin1'));
      }
    }
    for (const token of form.match(/(?:[0-9a-f]{2}){6,}/gi) ?? []) {
      decoded.push(Buffer.from(token, 'hex').toString('latin1'));
    }
  }
  for (const list of text.match(/(?<![\w.])(?:\d{1,3}\s*,\s*){5,}\d{1,3}(?![\w.])/g) ?? []) {
    decoded.push(String.fromCharCode(...list.split(',').map((n) => Number(n.trim()) & 0xff)));
  }
  const found = new Set<string>();
  for (const form of decoded) {
    if (/\.wasm(?:[?#\s\0]|$)|\0asm/i.test(form)) found.add('a .wasm name or a module header');
    for (const host of originsIn(form)) {
      if (host.includes('.') && !ALLOWED_ORIGINS.has(host)) found.add(`a URL on ${host}`);
    }
  }
  return [...found].sort();
}

/**
 * Primitives that replace what the runtime relies on (fetch, WebAssembly, a prototype, chrome.runtime.getURL): the sources
 * can not contain them (eslint.config.js); this is the same check on what was built.
 */
const TAMPERING = [
  {
    pattern:
      /\b(?:defineProperty|defineProperties|setPrototypeOf|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__)\b/,
    what: 'defineProperty/setPrototypeOf',
  },
  { pattern: /__proto__/, what: '__proto__' },
  {
    pattern: /\bReflect\s*\.\s*(?:set|defineProperty|deleteProperty|setPrototypeOf)\b/,
    what: 'Reflect.set/defineProperty',
  },
  {
    pattern:
      /(?<![\w$.])(?:globalThis|self|window)\s*(?:\.\s*[\w$]+|\[[^\]]*\])+\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/,
    what: 'a write to a global object',
  },
  {
    pattern:
      /\.prototype\s*(?:\.\s*[\w$]+|\[[^\]]*\])+\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/,
    what: 'a write to a prototype',
  },
];

/** What a script spells that replaces or changes a global, a property or a prototype; empty if nothing. */
export function tamperingPrimitives(text: string): string[] {
  return TAMPERING.filter(({ pattern }) => pattern.test(text)).map(({ what }) => what);
}

/**
 * Names a script of the build does not use at all (the vendored runtime files are exempt, as everywhere): other ways to talk to
 * the network, to run code in another global scope, to decode text into a URL, to tell a test from a user, to empty the
 * resource timing buffer or to touch WebAssembly. The sources are held to an allowlist of globals (eslint.config.js); this
 * is what was built, dependencies included. Allowed by file where the source needs it: btoa and fromCharCode encode the
 * screenshot in the service worker.
 */
const FORBIDDEN_NAMES: readonly { pattern: RegExp; allowedIn?: RegExp }[] = [
  {
    pattern:
      /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|SharedWorker|Worker|WorkerGlobalScope|BroadcastChannel|MessageChannel|postMessage|TextDecoder|atob|unescape|decodeURI|fromCodePoint|webdriver|setResourceTimingBufferSize|clearResourceTimings|WebAssembly|instantiateStreaming|compileStreaming|contentWindow|getBackgroundPage|getViews|relatedTarget|srcElement|composedPath|parentWindow|currentTarget)\b|\b(?:(?:webkit|moz)?RTC[A-Z]\w*|WebTransport\w*)\b/,
  },
  { pattern: /\b(?:btoa|fromCharCode)\b/, allowedIn: /^background\.js$/ },
  // fetch and Request only where the CSP of the extension applies (connect-src 'self') and the code needs them: the result page
  // reads meta.json and the model, nothing else does. The content script (select.js) runs in the web page's process, outside that CSP.
  { pattern: /\b(?:fetch|Request)\b/, allowedIn: /^(?:background\.js|assets\/result-[\w-]+\.js)$/ },
  { pattern: /\bimport\s*\(/ },
  { pattern: /\b(?:eval|Function)\b/ },
];

/** The forbidden names a built script uses, without duplicates. */
export function forbiddenNames(file: string, text: string): string[] {
  const names = new Set<string>();
  for (const { pattern, allowedIn } of FORBIDDEN_NAMES) {
    if (allowedIn?.test(file) === true) continue;
    const match = new RegExp(pattern.source, 'g');
    for (const found of text.matchAll(match)) names.add(found[0].replace(/\s+/g, ''));
  }
  return [...names].sort();
}

/**
 * `defaultView` hands over the Window of a document. The page scripts of the result and welcome pages hold it once, in
 * `const win = doc.defaultView; if (!win) return;` (hashchange, pagehide, location); anywhere else in the build it is an
 * object that can be passed to Object.assign or Reflect (round 3 of the review of PR #6). Empty if the use is that one.
 */
export function windowReaches(file: string, text: string): string[] {
  const allowed =
    /\b(?:const|let|var)\s+[\w$]+\s*=\s*[\w$]+\.defaultView\s*;\s*if\s*\(\s*!\s*[\w$]+\s*\)\s*return\b/g;
  const pageScript = /^assets\/(?:result|welcome)-[\w-]+\.js$/.test(file);
  const kept = pageScript ? text.replace(allowed, '') : text;
  const alone = pageScript ? (text.match(allowed)?.length ?? 0) <= 1 : true;
  return /\bdefaultView\b/.test(kept) || !alone
    ? [`${file}: reaches the Window of a document (defaultView)`]
    : [];
}

/** The chunk that imports the vendored runtime is the one that configures it (src/result/model.ts is bundled into it). */
const RUNTIME_IMPORT = /\bfrom\s*["']\.\.\/ort\/ort\.wasm\.min\.mjs["']/;
export const importsRuntime = (text: string): boolean => RUNTIME_IMPORT.test(text);

const NAME = '[A-Za-z_$][\\w$]*';
/** What must follow a value for it to be that value alone: the end of the expression. */
const END = '(?=\\s*(?:[;,)}\\]]|$))';
const RUNTIME_URL = 'chrome\\.runtime\\.getURL\\("ort\\/"\\)';
/** `proxy = true` as terser writes it (`!0`) or as written: the runtime runs, and fetches its files, in a worker of its own. */
const PROXY_TRUE = new RegExp(`\\.proxy\\s*=\\s*(?:!0|true)${END}`, 'g');
const DEFINITION = new RegExp(
  `(?:\\b(?:var|let|const)\\s+(${NAME})\\s*=\\s*\\(\\)\\s*=>\\s*${RUNTIME_URL}${END}|\\bfunction\\s+(${NAME})\\s*\\(\\)\\s*\\{\\s*return\\s*${RUNTIME_URL}\\s*;?\\s*\\})`,
  'g',
);
const ASSIGNMENT = new RegExp(
  `\\.wasmPaths\\s*=\\s*(?:${RUNTIME_URL}|(${NAME})\\s*\\(\\s*\\))${END}`,
  'g',
);
/**
 * The other mentions of the two settings that the minified chunk of src/result/model.ts legitimately has: the descriptor
 * reads and the destructuring of assertPinnedRuntime and the words of its two messages. Written for what terser emits
 * today (the lockfile pins it); a different shape fails closed and is edited here on purpose.
 */
const READS = [
  new RegExp(
    `getOwnPropertyDescriptor\\(\\s*${NAME}\\s*,\\s*"(?:wasmPaths|wasmBinary|proxy)"\\s*\\)`,
    'g',
  ),
  new RegExp(`\\{\\s*wasmBinary\\s*:\\s*${NAME}\\s*\\}\\s*=\\s*${NAME}`, 'g'),
  /Refusing to start: proxy must be true/g,
  /Refusing to start: wasmPaths must be exactly/g,
  /Refusing to start: wasmBinary must not be set/g,
];

/**
 * Problems of the settings of the runtime in one built script. Outside the chunk that imports the runtime the two names
 * may not occur at all. In that chunk `wasmPaths` is assigned exactly once, and the value is exactly
 * `chrome.runtime.getURL("ort/")`: written there, or returned by the one function that is defined as exactly that
 * (nothing computed, decoded, conditional, wrapped or from a literal); every other mention is one of READS.
 */
function runtimeSettingProblems(file: string, text: string): string[] {
  if (!importsRuntime(text)) {
    return /wasmPaths|wasmBinary/.test(text)
      ? [
          `${file}: mentions wasmPaths/wasmBinary but does not configure the vendored runtime (a setting that could point onnxruntime-web at other code or bytes)`,
        ]
      : [];
  }
  const assignments = [...text.matchAll(ASSIGNMENT)];
  const definitions = [...text.matchAll(DEFINITION)].map((match) => match[1] ?? match[2]);
  const caller = assignments[0]?.[1];
  const exact =
    assignments.length === 1 &&
    (caller === undefined || definitions.filter((name) => name === caller).length === 1);
  // the start-up check of src/result/model.ts (assertPinnedRuntime) is there and is called with the runtime URL
  const call = new RegExp(
    `\\(\\s*${NAME}\\.env\\s*,\\s*(?:${RUNTIME_URL}|(${NAME})\\s*\\(\\s*\\))\\s*\\)`,
  ).exec(text);
  const checkIsCalled = call !== null && (call[1] === undefined || definitions.includes(call[1]));
  const checkExists =
    READS.slice(2).every((message) => new RegExp(message.source).test(text)) &&
    (text.match(READS[0] ?? /$^/g)?.length ?? 0) >= 3;
  // `proxy` is assigned exactly once, to true: any other assignment (or none) leaves the runtime in this page's realm
  const proxyAssignments = (text.match(/\.proxy\s*=(?!=)/g) ?? []).length;
  const proxyExact = proxyAssignments === 1 && [...text.matchAll(PROXY_TRUE)].length === 1;
  let rest = text.replace(ASSIGNMENT, '').replace(PROXY_TRUE, '');
  for (const read of READS) rest = rest.replace(read, '');
  const stray = /wasmPaths|wasmBinary/.exec(rest);
  const problems: string[] = [];
  if (!exact) {
    problems.push(
      `${file}: wasmPaths must be assigned exactly once, and its value exactly chrome.runtime.getURL("ort/") (found ${String(assignments.length)} assignment(s))`,
    );
  }
  if (!proxyExact) {
    problems.push(
      `${file}: proxy must be assigned exactly once, to true (the runtime must fetch its files in its own worker; found ${String(proxyAssignments)} assignment(s))`,
    );
  }
  if (!checkIsCalled || !checkExists) {
    problems.push(
      `${file}: the start-up check of the runtime (assertPinnedRuntime, called with the packaged directory) is missing`,
    );
  }
  if (stray !== null) {
    problems.push(
      `${file}: ${stray[0]} appears in a form the runtime configuration does not have (check scripts/lib/wasm-scan.ts)`,
    );
  }
  return problems;
}

/**
 * The SECOND layer for the code that runs in the web page's process, where the CSP of the extension does not apply (round 6 of
 * the review of PR #6; the first layer is lint plus the module graph of select.js, which also hold names built at run time):
 * no network API, no way to load or navigate, spelled with a literal name. `select.js` is that code as a whole; of
 * `background.js` it is the function handed to `chrome.scripting.executeScript({ func })` (measureImage), found in the AST.
 */
const PAGE_CODE_FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  {
    pattern:
      /\b(?:fetch|Request|XMLHttpRequest|WebSocket|EventSource|WebTransport\w*|sendBeacon|importScripts|SharedWorker|Worker|Image|Audio|Option|DOMParser|FontFace|(?:webkit|moz)?RTC[A-Z]\w*)\b/,
    what: 'a network API (fetch, XMLHttpRequest, WebSocket, EventSource, Image, Audio, Worker, RTC*, ...)',
  },
  { pattern: /\bimport\s*\(/, what: 'a dynamic import()' },
  {
    pattern:
      /\.\s*(?:src|srcset|srcdoc|href|action|formAction|poster|ping|innerHTML|outerHTML)\s*=(?!=)/,
    what: 'an assignment to src/href/srcset/action/innerHTML/...',
  },
  {
    pattern:
      /\b(?:setAttribute|setAttributeNS|setAttributeNode|insertAdjacentHTML|insertAdjacentElement|createContextualFragment|insertRule|replaceSync)\b/,
    what: 'setAttribute / insertAdjacentHTML / insertRule',
  },
  { pattern: /\bopen\s*\(/, what: 'open(...) (window.open, XMLHttpRequest.open)' },
  { pattern: /\blocation\b/, what: 'location' },
];

/**
 * Does a string literal of the script hold CSS that loads something (url(), image-set(), @import, ...)? Judged as lint judges it
 * (CSS_LOADING_SOURCE and cssUnescape of eslint.config.js): only strings are looked at, so `getURL(` and `new URL(` in the code are
 * not CSS; the CSS escapes of a string (`u\\72 l(`) are undone first, and so are the JS ones (`\\\\`).
 */
export function cssLoadingInStrings(text: string): boolean {
  const loading = new RegExp(CSS_LOADING_SOURCE, 'i');
  return stringForms(text).some((form) => {
    const jsDecoded = form.replace(/\\\\/g, '\\');
    return [form, jsDecoded, cssUnescape(form), cssUnescape(jsDecoded)].some((candidate) =>
      loading.test(candidate),
    );
  });
}

/** What of the page-process rules a text breaks; empty if nothing. */
export function pagePlatformProblems(text: string): string[] {
  const found = PAGE_CODE_FORBIDDEN.filter(({ pattern }) => pattern.test(text)).map(
    ({ what }) => what,
  );
  if (cssLoadingInStrings(text)) found.push('url(...) / image-set / @import in a string');
  return found;
}

/**
 * The text of every function that a script hands to `executeScript({ func })`, found with the TypeScript compiler so that names
 * are resolved by SCOPE (a minified file reuses short names): the `func` must be a function written in place or a name with ONE
 * declaration, in this file, that is a function declaration or a variable holding a function; a shorthand `{ func }` and a method
 * `func() {}` are read too. Anything else - an import, a member (`o.f`), a computed key, a spread, options that are not an object
 * literal, an `executeScript` that is not called at once (an alias) - is an `undefined` entry, which fails the build.
 */
export function injectedFunctions(file: string, text: string): (string | undefined)[] {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === file
      ? ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.JS)
      : getSourceFile(name, languageVersion, ...rest);
  host.fileExists = (name) => name === file;
  host.readFile = (name) => (name === file ? text : undefined);
  const program = ts.createProgram([file], options, host);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (source === undefined) return [undefined];
  const isFunction = (node: ts.Node | undefined): node is ts.Node =>
    node !== undefined &&
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node));
  /** Is the symbol assigned to, incremented, or the target of a loop or a destructuring, anywhere in the file? */
  const isWrittenTo = (symbol: ts.Symbol): boolean => {
    let written = false;
    const refersTo = (node: ts.Node): boolean => {
      let hit = false;
      const look = (inner: ts.Node): void => {
        if (ts.isIdentifier(inner) && checker.getSymbolAtLocation(inner) === symbol) hit = true;
        ts.forEachChild(inner, look);
      };
      look(node);
      return hit;
    };
    const scan = (node: ts.Node): void => {
      if (
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          refersTo(node.left)) ||
        ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken) &&
          refersTo(node.operand)) ||
        ((ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
          !ts.isVariableDeclarationList(node.initializer) &&
          refersTo(node.initializer))
      ) {
        written = true;
      }
      ts.forEachChild(node, scan);
    };
    scan(source);
    return written;
  };
  /** The function a symbol is: ONE declaration, a function declaration or a `const` holding a function, and never written to. */
  const functionOf = (symbol: ts.Symbol | undefined): ts.Node | undefined => {
    const declarations = symbol?.declarations ?? [];
    const only = declarations.length === 1 ? declarations[0] : undefined;
    if (symbol === undefined || only === undefined || isWrittenTo(symbol)) return undefined;
    if (ts.isFunctionDeclaration(only)) return only;
    if (
      ts.isVariableDeclaration(only) &&
      ts.isVariableDeclarationList(only.parent) &&
      (only.parent.flags & ts.NodeFlags.Const) !== 0 &&
      isFunction(only.initializer)
    ) {
      return only.initializer;
    }
    return undefined;
  };
  const found: (string | undefined)[] = [];
  const read = (node: ts.Node | undefined): void => {
    found.push(node?.getText(source));
  };
  const isTheName = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && node.text === 'executeScript') ||
    ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text === 'executeScript');
  const visit = (node: ts.Node): void => {
    if (isTheName(node)) {
      // the name may only be the callee of a direct call `x.executeScript({ ... })`; anything else - an alias, a destructuring
      // (`const { executeScript: run } = chrome.scripting`), a string key, `.call`, a value passed on - cannot be followed
      const access = node.parent;
      const call = access.parent;
      if (
        ts.isPropertyAccessExpression(access) &&
        access.name === node &&
        ts.isCallExpression(call) &&
        call.expression === access
      ) {
        const options0 = call.arguments[0];
        if (options0 === undefined || !ts.isObjectLiteralExpression(options0)) {
          found.push(undefined);
        } else {
          for (const property of options0.properties) {
            if (ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name)) {
              found.push(undefined);
              continue;
            }
            const key = property.name;
            const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
            if (name !== 'func') continue;
            if (ts.isShorthandPropertyAssignment(property)) {
              read(functionOf(checker.getShorthandAssignmentValueSymbol(property)));
            } else if (ts.isMethodDeclaration(property)) {
              read(property);
            } else if (ts.isPropertyAssignment(property)) {
              const value = property.initializer;
              if (ts.isIdentifier(value)) read(functionOf(checker.getSymbolAtLocation(value)));
              else if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) read(value);
              else found.push(undefined);
            } else {
              found.push(undefined);
            }
          }
        }
      } else {
        found.push(undefined);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Problems of one built script (`file` relative to the build, `text` its contents): a WebAssembly module in it, or settings
 * that would make onnxruntime-web load other code or bytes.
 */
export function scriptProblems(file: string, text: string): string[] {
  const problems = wasmSignatures(text).map(
    (spelling) =>
      `${file}: carries a WebAssembly module or names one (${spelling}); only the pinned vendor files may`,
  );
  const origins = urlOrigins(text)
    .filter((host) => !ALLOWED_ORIGINS.has(host))
    .map(
      (host) =>
        `${file}: names a URL on ${host}; the only hosts a script of the build may name are ${[...ALLOWED_ORIGINS].join(', ')}`,
    );
  const tampering = tamperingPrimitives(text).map(
    (what) =>
      `${file}: uses a primitive that replaces or changes a global, a property or a prototype (${what})`,
  );
  const ice = iceServerSchemes(text).map(
    (scheme) =>
      `${file}: names a WebRTC server (${scheme}:), which no script of the build does (a STUN or TURN server is a connection to the internet that is no URL)`,
  );
  const hidden = hiddenTexts(text).map(
    (what) => `${file}: has text that decodes to ${what} (base64, hex or a list of bytes)`,
  );
  const names = forbiddenNames(file, text).map(
    (name) =>
      `${file}: uses ${name}, which no script of the build uses (the sources are held to an allowlist of globals, see eslint.config.js)`,
  );
  const injected = file === 'background.js' ? injectedFunctions(file, text) : [];
  const page = [
    ...(file === 'select.js' ? pagePlatformProblems(text) : []),
    ...injected.flatMap((body) =>
      body === undefined
        ? [
            'a func of executeScript that could not be read (not a function declared once in this file)',
          ]
        : pagePlatformProblems(body),
    ),
    ...(file === 'background.js' && injected.length !== 1
      ? [`exactly one function must be handed to executeScript (found ${String(injected.length)})`]
      : []),
    ...(file !== 'background.js' && /\bexecuteScript\b/.test(text)
      ? ['executeScript outside background.js']
      : []),
  ].map(
    (what) =>
      `${file}: code that runs in the web page's process (outside the CSP of the extension) has ${what}`,
  );
  return [
    ...problems,
    ...origins,
    ...tampering,
    ...page,
    ...ice,
    ...hidden,
    ...names,
    ...windowReaches(file, text),
    ...runtimeSettingProblems(file, text),
  ];
}
