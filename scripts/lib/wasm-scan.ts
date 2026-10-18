/**
 * WebAssembly other than the pinned vendor files could reach the extension inside a built script, past every check
 * of the build: as the bytes of a module (a literal, base64, hex, an escape, a list of numbers) or through the
 * settings of onnxruntime-web that name other code (`wasmPaths`: another URL; `wasmBinary`: other bytes). This is the
 * check of the built files for both; the sources are guarded by eslint.config.js and tests/unit/model.test.ts.
 * The vendor files themselves are exempt by exact path AND sha256 (vendor.ts), never by prefix.
 */

/** The header of every module: 00 61 73 6d ("\0asm"). */
const HEADER = [
  { pattern: /\0asm/, spelling: 'the raw bytes \\0asm' },
  { pattern: /\\(?:x0{2}|u0{4}|u\{0+\}|0{1,3})asm/i, spelling: 'an escape of \\0asm' },
  { pattern: /AGFzbQ/, spelling: 'base64 (AGFzbQ)' },
  { pattern: /0061736d/i, spelling: 'hex (0061736d)' },
  {
    // 0, 97, 115, 109 in any radix: decimal, 0x61, 0b1100001, 0o141
    pattern:
      /(?<![\w.])(?:0|0x0+|0b0+|0o0+)\s*,\s*(?:97|0x61|0b1100001|0o141)\s*,\s*(?:115|0x73|0b1110011|0o163)\s*,\s*(?:109|0x6d|0b1101101|0o155)(?![\w.])/i,
    spelling: 'the byte list 0,97,115,109',
  },
  // a reference to a module file by name (but not `env.wasm.wasmPaths`)
  { pattern: /[\w/-]\.wasm(?=["'`?#]|$)/, spelling: 'a reference to a .wasm file' },
];

/** The ways a text spells the header of a WebAssembly module (or names a .wasm file); empty if none. */
export function wasmSignatures(text: string): string[] {
  return HEADER.filter(({ pattern }) => pattern.test(text)).map(({ spelling }) => spelling);
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
  let rest = text.replace(ASSIGNMENT, '');
  for (const read of READS) rest = rest.replace(read, '');
  const stray = /wasmPaths|wasmBinary/.exec(rest);
  const problems: string[] = [];
  if (!exact) {
    problems.push(
      `${file}: wasmPaths must be assigned exactly once, and its value exactly chrome.runtime.getURL("ort/") (found ${String(assignments.length)} assignment(s))`,
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
  return [...problems, ...runtimeSettingProblems(file, text)];
}
