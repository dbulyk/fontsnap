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

/** Hosts of the absolute and protocol-relative URLs that the string literals of a script spell (any scheme, escapes and %-escapes decoded). */
export function urlOrigins(text: string): string[] {
  const hosts = new Set<string>();
  const url = /(?:^|[^A-Za-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/\s@]*@)?([^/\s:"'`?#\\@]+)/gi;
  for (const form of stringForms(text)) {
    for (const match of form.matchAll(url)) hosts.add((match[1] ?? '').toLowerCase());
  }
  return [...hosts].sort();
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

/** The chunk that imports the vendored runtime is the one that configures it (src/result/model.ts is bundled into it). */
const RUNTIME_IMPORT = /\bfrom\s*["']\.\.\/ort\/ort\.wasm\.min\.mjs["']/;
export const importsRuntime = (text: string): boolean => RUNTIME_IMPORT.test(text);

const NAME = '[A-Za-z_$][\\w$]*';
/** What must follow a value for it to be that value alone: the end of the expression. */
const END = '(?=\\s*(?:[;,)}\\]]|$))';
const RUNTIME_URL = 'chrome\\.runtime\\.getURL\\("ort\\/"\\)';
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
  new RegExp(`getOwnPropertyDescriptor\\(\\s*${NAME}\\s*,\\s*"wasm(?:Paths|Binary)"\\s*\\)`, 'g'),
  new RegExp(`\\{\\s*wasmBinary\\s*:\\s*${NAME}\\s*\\}\\s*=\\s*${NAME}`, 'g'),
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
  const mentions = (text.match(/wasmPaths|wasmBinary/g) ?? []).length;
  if (mentions === 0) return [];
  if (!importsRuntime(text)) {
    return [
      `${file}: mentions wasmPaths/wasmBinary but does not configure the vendored runtime (a setting that could point onnxruntime-web at other code or bytes)`,
    ];
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
    (text.match(READS[0] ?? /$^/g)?.length ?? 0) >= 2;
  let rest = text.replace(ASSIGNMENT, '');
  for (const read of READS) rest = rest.replace(read, '');
  const stray = /wasmPaths|wasmBinary/.exec(rest);
  const problems: string[] = [];
  if (!exact) {
    problems.push(
      `${file}: wasmPaths must be assigned exactly once, and its value exactly chrome.runtime.getURL("ort/") (found ${String(assignments.length)} assignment(s))`,
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
  return [...problems, ...origins, ...tampering, ...runtimeSettingProblems(file, text)];
}
