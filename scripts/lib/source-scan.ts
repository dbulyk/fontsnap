import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The coverage tools look for these markers in the source text itself (not only in comments, and
// with any prefix such as `@preserve` or `keep:`), so the scan does the same.
const COVERAGE_IGNORE = /(?:istanbul|[cv]8|node:coverage)\s+(?:ignore|disable|enable)\b/;

/** 1-based lines of `text` that carry a coverage ignore marker (v8, c8, istanbul, node:coverage). */
export function findCoverageIgnore(text: string): number[] {
  return text.split('\n').flatMap((line, index) => (COVERAGE_IGNORE.test(line) ? [index + 1] : []));
}

export const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Every file of the repository, as git sees it: tracked files plus untracked files that are not
 * ignored (a new file is checked before it is committed). Files deleted from the work tree are
 * skipped. Directories are never skipped: code anywhere in the repository is found.
 */
export function listRepoFiles(root = '.'): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((name) => name !== '');
  const names = new Set([
    ...git('ls-files', '-z'),
    ...git('ls-files', '-z', '--others', '--exclude-standard'),
  ]);
  return [...names].filter((name) => existsSync(join(root, name))).sort();
}

/** JavaScript and TypeScript files anywhere in the repository (see `listRepoFiles`). */
export function listSourceFiles(root = '.'): string[] {
  return listRepoFiles(root).filter((file) => CODE_FILE.test(file));
}
