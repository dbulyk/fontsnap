import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import ts from 'typescript';
import { build, type Rollup } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

// select.js runs in the web page's process, where the CSP of the extension does not apply. The lint rules for that code are the rules
// of the folder src/select (eslint.config.js, PAGE_PROCESS_GLOBS), and that folder imports values from itself only. This test reads
// the REAL bundle (the build of vite.content.config.ts, in memory) and shows that nothing else got into it - whatever the lint
// configuration says, so a rule that was loosened, bypassed or forgotten still cannot let a module of src/shared into select.js
// (review round 6 of PR #6: src/shared/page-probe.ts, handed `doc` by the overlay, reached the Window with a cast).
const ROOT = process.cwd();
const SELECT_DIR = resolve(ROOT, 'src', 'select') + sep;
const scratch = mkdtempSync(join(tmpdir(), 'select-bundle-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function bundleModules(): Promise<{ files: string[]; chunks: string[] }> {
  const result = await build({
    root: ROOT,
    configFile: join(ROOT, 'vite.content.config.ts'),
    configLoader: 'bundle',
    mode: 'production',
    logLevel: 'silent',
    build: { write: false, outDir: scratch, emptyOutDir: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (one): (Rollup.OutputChunk | Rollup.OutputAsset)[] => ('output' in one ? one.output : []),
  );
  const chunks = outputs.filter((output) => output.type === 'chunk');
  return {
    files: chunks.flatMap((chunk) => chunk.moduleIds),
    chunks: chunks.map((chunk) => chunk.fileName),
  };
}

describe('the content script bundle (select.js) holds modules of src/select only', () => {
  it('is one file, select.js, made of nothing but files of src/select', async () => {
    const { files, chunks } = await bundleModules();
    expect(chunks).toEqual(['select.js']);
    const real = files.filter((file) => !file.startsWith('\0'));
    expect(real.length).toBeGreaterThanOrEqual(2);
    expect(real.filter((file) => !file.startsWith(SELECT_DIR))).toEqual([]);
    for (const required of ['overlay.ts', 'index.ts', 'chrome.ts']) {
      expect(real).toContain(join(SELECT_DIR, required));
    }
  }, 60_000);

  it('imports nothing at all that is not a type from outside src/select (the source, as the build sees it)', () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of ts.sys.readDirectory(dir, ['.ts'])) {
        const source = ts.createSourceFile(
          entry,
          readFileSync(entry, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        for (const statement of source.statements) {
          const from =
            ts.isImportDeclaration(statement) ||
            (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined)
              ? statement.moduleSpecifier
              : undefined;
          if (from === undefined || !ts.isStringLiteral(from)) continue;
          const typeOnly = ts.isImportDeclaration(statement)
            ? statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
            : (statement as ts.ExportDeclaration).isTypeOnly;
          if (!typeOnly && !/^\.\/([\w-]+\/)*[\w-]+$/.test(from.text))
            offenders.push(`${entry}: ${from.text}`);
        }
      }
    };
    visit(SELECT_DIR);
    expect(offenders).toEqual([]);
  });

  it.each(['measure.ts', 'load-image.ts'])(
    'the function injected by chrome.scripting (%s) imports no value at all',
    (name) => {
      const text = readFileSync(join(ROOT, 'src', 'background', name), 'utf8');
      const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
      const values = source.statements.filter(
        (statement) =>
          (ts.isImportDeclaration(statement) &&
            statement.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) ||
          (ts.isExportDeclaration(statement) &&
            statement.moduleSpecifier !== undefined &&
            !statement.isTypeOnly),
      );
      expect(values.map((statement) => statement.getText(source))).toEqual([]);
    },
  );
});
