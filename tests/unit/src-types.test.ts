import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseTsconfig } from '../../scripts/lib/tsconfig';

/**
 * Type-checks the real `src` program of tsconfig.src.json plus virtual extra files. Because every
 * real src file is part of the program, a `/// <reference types="node" />` or a `declare const
 * process` shim in any of them makes Node globals visible to the probe and fails these tests.
 */
function diagnosticsFor(probeSource: string, extra: Record<string, string> = {}): string[] {
  const cwd = process.cwd();
  const parsed = parseTsconfig(join(cwd, 'tsconfig.src.json'));
  const probe = join(cwd, 'src', '__probe__.ts');
  const virtual = new Map<string, string>([
    [probe, probeSource],
    ...Object.entries(extra).map(([name, text]) => [join(cwd, name), text] as const),
  ]);
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => virtual.has(name) || fileExists(name);
  host.readFile = (name) => virtual.get(name) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    const text = virtual.get(name);
    return text === undefined
      ? getSourceFile(name, languageVersion, ...rest)
      : ts.createSourceFile(name, text, languageVersion);
  };
  const program = ts.createProgram([...parsed.fileNames, ...virtual.keys()], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === probe)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

describe('extension code is type-checked without Node types', () => {
  it('accepts browser and chrome APIs', () => {
    const code = 'export const url = chrome.runtime.getURL("x"); export const d = document.title;';
    expect(diagnosticsFor(code)).toEqual([]);
  });

  it.each([
    ['process', 'export const cwd = process.cwd();'],
    ['Buffer', 'export const b = Buffer.from("x");'],
    ['require', 'export const fs = require("fs");'],
    ['__dirname', 'export const dir = __dirname;'],
  ])('rejects the Node global %s', (_name, source) => {
    expect(diagnosticsFor(source)).not.toEqual([]);
  });

  // Proves the probe sees a leak, so the passing tests above mean no real src file has one.
  it.each([
    [
      'a triple-slash reference to node types',
      { 'src/popup/shim.ts': '/// <reference types="node" />\nexport {};' },
    ],
    [
      'a declare shim in a .d.ts file',
      { 'src/popup/shim.d.ts': 'declare const process: { cwd(): string };' },
    ],
  ])('would notice %s in any src file', (_name, extra) => {
    expect(diagnosticsFor('export const cwd = process.cwd();', extra)).toEqual([]);
  });
});
