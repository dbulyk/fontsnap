import { describe, expect, it } from 'vitest';
import { RESULT_CHUNK, scriptProblems, wasmSignatures } from '../../scripts/lib/wasm-scan';

// WebAssembly can reach a built script as bytes: written out as a literal, base64, hex, an escape or a number list.
// Whatever the spelling, a script of the build that carries the header of a module (\0asm) is refused, unless it is
// one of the pinned vendor files (checked by path and sha256 elsewhere).
describe('wasmSignatures', () => {
  const NUL = String.fromCharCode(0);
  it.each([
    ['the raw header bytes', `var m="${NUL}asm${String.fromCharCode(1)}";`],
    ['a \\0 escape', 'var m="\\0asm\\x01";'],
    ['a \\x00 escape', 'var m="\\x00asm";'],
    ['a \\u0000 escape', 'var m="\\u0000asm";'],
    ['a \\u{0} escape', 'var m="\\u{0}asm";'],
    ['an octal escape', 'var m="\\000asm";'],
    [
      'base64',
      'fetch("data:application/wasm;base64,AGFzbQEAAAABBgFgAX8BfwMCAQAHBwEDYWRkAAAKCQEHACAAQQFqCw==")',
    ],
    ['base64 alone', 'const b="AGFzbQ";'],
    ['a hex string', 'const h="0061736d01000000";'],
    ['a hex string in upper case', 'const h="0061736D01000000";'],
    ['a decimal list', 'new Uint8Array([0,97,115,109,1,0,0,0])'],
    ['a decimal list with spaces', 'new Uint8Array([ 0 , 97 , 115 , 109 ])'],
    ['String.fromCharCode', 'String.fromCharCode(0,97,115,109)'],
    ['a hex list', 'new Uint8Array([0x00,0x61,0x73,0x6d])'],
    ['a hex list in upper case', 'new Uint8Array([0X00,0X61,0X73,0X6D])'],
    ['a mixed list', 'new Uint8Array([0,0x61,115,0b1101101])'],
    ['an octal list', 'new Uint8Array([0,0o141,0o163,0o155])'],
    ['a reference to a .wasm file', 'fetch("https://cdn.example.com/x.wasm")'],
    ['a relative .wasm file', 'new URL("./x.wasm", import.meta.url)'],
  ])('finds %s', (_name, code) => {
    expect(wasmSignatures(code), code).not.toEqual([]);
  });

  it.each([
    'const a=[0,97,115];',
    'const a=[1,97,115,109];',
    'var s="asm.js";',
    'const wasm="webassembly";',
    'x.wasmPaths',
    'const n="AGFzb";',
    'var t="00617365";',
    'const w=document.createElement("wasm-viewer");',
    'return t.slice(0,97)+u.slice(115,109)',
  ])('does not mistake %j for a module', (code) => {
    expect(wasmSignatures(code), code).toEqual([]);
  });
});

describe('scriptProblems: the runtime settings that would load other WebAssembly', () => {
  const ok =
    'async function I(){o.env.wasm.wasmPaths=chrome.runtime.getURL("ort/"),o.env.wasm.numThreads=1}';
  const RESULT = 'assets/result-4HZRFhwR.js';

  it('names the one legitimate chunk', () => {
    expect(RESULT_CHUNK.test(RESULT)).toBe(true);
    for (const other of [
      'assets/welcome-abc.js',
      'background.js',
      'select.js',
      'assets/ort/result-abc.js',
      'result-abc.js',
      'assets/result-abc.mjs',
      'ort/result-abc.js',
    ]) {
      expect(RESULT_CHUNK.test(other), other).toBe(false);
    }
  });

  it('accepts the result chunk that sets wasmPaths once, from a call', () => {
    expect(scriptProblems(RESULT, ok)).toEqual([]);
    expect(scriptProblems(RESULT, 'e.wasm.wasmPaths = f()')).toEqual([]);
    expect(scriptProblems(RESULT, 'e.wasm.wasmPaths=chrome.runtime.getURL(R)')).toEqual([]);
  });

  it.each([
    ['a string literal', 'o.env.wasm.wasmPaths="https://cdn.example.com/ort/"'],
    ['a template', 'o.env.wasm.wasmPaths=`https://cdn.example.com/`'],
    ['an object', 'o.env.wasm.wasmPaths={wasm:u,mjs:v}'],
    ['an object key', 'init({wasmPaths:"https://cdn.example.com/"})'],
    ['a plain variable', 'o.env.wasm.wasmPaths=where'],
    ['a second setting', `${ok};${ok}`],
    ['a read', 'use(o.env.wasm.wasmPaths)'],
  ])('rejects wasmPaths set from %s', (_name, code) => {
    expect(scriptProblems(RESULT, code).join('\n'), code).toContain('wasmPaths');
  });

  it.each([
    'assets/welcome-abc.js',
    'assets/i18n-abc.js',
    'background.js',
    'select.js',
    'assets/ort/result-abc.js',
    'result-abc.js',
  ])('rejects wasmPaths in %s, which has no business with the runtime', (file) => {
    expect(scriptProblems(file, ok).join('\n')).toContain('wasmPaths');
  });

  it('rejects wasmBinary everywhere, the result chunk included', () => {
    for (const file of [RESULT, 'background.js', 'assets/x.js', 'ort/other.mjs']) {
      expect(scriptProblems(file, 'o.env.wasm.wasmBinary=bytes').join('\n'), file).toContain(
        'wasmBinary',
      );
      expect(scriptProblems(file, 'const {wasmBinary:b}=o.env.wasm').join('\n'), file).toContain(
        'wasmBinary',
      );
    }
  });

  it('reports a module header in any script', () => {
    expect(scriptProblems('assets/x.js', 'new Uint8Array([0,97,115,109])').join('\n')).toMatch(
      /WebAssembly module/,
    );
  });

  it('has nothing to say about an ordinary script', () => {
    expect(scriptProblems('assets/x.js', 'export const a=1;function f(){return[0,1,2,3]}')).toEqual(
      [],
    );
  });
});
