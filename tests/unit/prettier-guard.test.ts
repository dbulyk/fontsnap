import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPrettier } from '../../scripts/lib/prettier-guard';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway project; returns its root and the file names it contains. */
function project(files: Record<string, string>): {
  root: string;
  names: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'prettier-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return { root, names: Object.keys(files) };
}

const base = {
  '.prettierrc.json': '{ "singleQuote": true }\n',
  'package.json': '{}\n',
  'src/a.ts': 'export const a = 1;\n',
  'README.md': '# x\n',
};

describe('inspectPrettier', () => {
  it('reports the root config and finds nothing wrong in a plain project', async () => {
    const { root, names } = project(base);
    expect(await inspectPrettier(root, names)).toEqual({
      config: { singleQuote: true },
      ignored: [],
      mismatched: [],
    });
  });

  it('skips files Prettier has no parser for', async () => {
    const { root, names } = project({
      ...base,
      'icon.png': 'x',
      'notes.unknownext': 'x',
    });
    const state = await inspectPrettier(root, names);
    expect(state.ignored).toEqual([]);
    expect(state.mismatched).toEqual([]);
  });

  it.each([
    [
      'a nested .prettierrc with requirePragma',
      { 'src/.prettierrc.json': '{ "requirePragma": true }\n' },
    ],
    ['a nested .prettierrc.yaml', { 'src/.prettierrc.yaml': 'semi: false\n' }],
    [
      'a nested prettier.config.js',
      { 'src/prettier.config.js': 'export default { semi: false };\n' },
    ],
    [
      'a nested .editorconfig changing indentation',
      { 'src/.editorconfig': '[*]\nindent_style = tab\n' },
    ],
    [
      'a "prettier" key in a nested package.json',
      { 'src/package.json': '{ "prettier": { "semi": false } }\n' },
    ],
  ])('flags every file under %s', async (_name, extra) => {
    const { root, names } = project({
      ...base,
      ...extra,
      'src/deep/b.ts': 'export const b = 2;\n',
    });
    const { mismatched } = await inspectPrettier(root, names);
    expect(mismatched).toEqual(expect.arrayContaining(['src/a.ts', 'src/deep/b.ts']));
    expect(mismatched).not.toContain('README.md');
  });

  it('reports files that .gitignore or .prettierignore hide from format:check', async () => {
    const { root, names } = project({
      ...base,
      '.gitignore': 'src/a.ts\n',
      '.prettierignore': 'README.md\n',
      'lock.json': '{}\n',
    });
    const { ignored } = await inspectPrettier(root, names);
    expect(ignored).toEqual(['README.md', 'src/a.ts']);
  });

  it('does not report an ignored file as a config mismatch', async () => {
    const { root, names } = project({
      ...base,
      '.prettierignore': 'src/\n',
      'src/.prettierrc.json': '{ "semi": false }\n',
    });
    const state = await inspectPrettier(root, names);
    expect(state.ignored).toContain('src/a.ts');
    expect(state.mismatched).not.toContain('src/a.ts');
  });
});
