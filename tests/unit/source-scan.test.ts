import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCoverageIgnore, listRepoFiles, listSourceFiles } from '../../scripts/lib/source-scan';

// The fixtures below are code strings; this file itself is excluded from the repository scan.
describe('findCoverageIgnore', () => {
  it.each([
    '// v8 ignore next',
    '/* v8 ignore start */',
    '/* v8 ignore stop */',
    '/** v8 ignore next */',
    '/* @preserve v8 ignore start */',
    '// keep: v8 ignore start',
    '/*v8 ignore next*/',
    '/* c8 ignore next 3 */',
    '/* c8 ignore */',
    '/* node:coverage ignore file */',
    '/* node:coverage ignore next */',
    '/* node:coverage disable */',
    '/* istanbul ignore next */',
    '/* istanbul ignore else */',
    '/** istanbul ignore if */',
    'if (a) { /* istanbul ignore if */ }',
    'const x = 1; // @preserve c8 ignore next',
  ])('flags %j anywhere in the text', (source) => {
    expect(findCoverageIgnore(`const a = 1;\n${source}\n`)).toEqual([2]);
  });

  it('reports every line', () => {
    expect(findCoverageIgnore('// v8 ignore next\n\n/* c8 ignore start */')).toEqual([1, 3]);
  });

  it('leaves ordinary prose and code alone', () => {
    const source = [
      '// the v8 engine and istanbul the city',
      'const ignore = 1; const c8 = 2;',
      "const message = 'coverage is ignored nowhere';",
    ].join('\n');
    expect(findCoverageIgnore(source)).toEqual([]);
  });
});

describe('listRepoFiles', () => {
  it('lists tracked and untracked files that are not ignored, and skips ignored and deleted ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      const write = (name: string, text = 'x') => {
        mkdirSync(dirname(join(root, name)), { recursive: true });
        writeFileSync(join(root, name), text);
      };
      git('init', '-q');
      write('.gitignore', 'ignored/\n');
      write('tracked.ts');
      write('gone.ts');
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
      unlinkSync(join(root, 'gone.ts'));
      write('lib/untracked.ts');
      write('ignored/hidden.ts');
      write('with space.ts');
      expect(listRepoFiles(root)).toEqual([
        '.gitignore',
        'lib/untracked.ts',
        'tracked.ts',
        'with space.ts',
      ]);
      expect(listSourceFiles(root)).toEqual(['lib/untracked.ts', 'tracked.ts', 'with space.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('this repository', () => {
  const files = listSourceFiles('.');

  it('scans source, tests, scripts and root configs', () => {
    for (const expected of [
      'src/result/app.ts',
      'scripts/lib/dist.ts',
      'eslint.config.js',
      'vite.config.ts',
    ]) {
      expect(files, expected).toContain(expected);
    }
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
  });

  // Matched against the whole text, the way the coverage tool does, not just against comments:
  // `// keep: v8 ignore start` and `/** v8 ignore next */` hide code from the thresholds too.
  it('has no coverage ignore marker in any file', () => {
    const hits = files
      .filter((file) => file !== 'tests/unit/source-scan.test.ts')
      .flatMap((file) =>
        findCoverageIgnore(readFileSync(file, 'utf8')).map((line) => `${file}:${String(line)}`),
      );
    expect(hits).toEqual([]);
  });
});
