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

/** The only chunk of the build that configures the runtime: the result page (src/result/model.ts is bundled into it). */
export const RESULT_CHUNK = /^assets\/result-[A-Za-z0-9_-]+\.js$/;

/** `x.wasmPaths = f(...)`: set once, from a call (chrome.runtime.getURL), never from a literal, object or variable. */
const WASM_PATHS_FROM_CALL = /\.wasmPaths\s*=\s*[A-Za-z_$][\w$.]*\s*\(/g;

/**
 * Problems of one built script (`file` relative to the build, `text` its contents): a WebAssembly module in it, the
 * `wasmBinary` setting anywhere, or `wasmPaths` anywhere but once, from a call, in the result chunk.
 */
export function scriptProblems(file: string, text: string): string[] {
  const problems = wasmSignatures(text).map(
    (spelling) =>
      `${file}: carries a WebAssembly module or names one (${spelling}); only the pinned vendor files may`,
  );
  if (text.includes('wasmBinary')) {
    problems.push(
      `${file}: mentions wasmBinary (onnxruntime-web would run bytes other than the pinned runtime)`,
    );
  }
  const mentions = text.split('wasmPaths').length - 1;
  if (mentions > 0) {
    const fromCall = text.match(WASM_PATHS_FROM_CALL)?.length ?? 0;
    if (!RESULT_CHUNK.test(file) || mentions !== 1 || fromCall !== 1) {
      problems.push(
        `${file}: wasmPaths may be set only once, from chrome.runtime.getURL(...), in the result chunk (it could point onnxruntime-web at other code)`,
      );
    }
  }
  return problems;
}
