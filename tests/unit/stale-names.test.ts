import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Comments that name a rule that does not exist send the next reader to nothing (review of PR #6, round 7: PAGE_PROCESS_FILES and
// pageImportSelectors were left in comments after the renames). The names of the rules of the web page's process are these:
const CURRENT = ['PAGE_PROCESS_GLOBS', 'selectImportSelectors', 'styleSelectors', 'STYLE_KEYS'];
const STALE = ['PAGE_PROCESS_FILES', 'pageImportSelectors'];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

describe('names of rules in comments and docs', () => {
  const sources = [
    ...files('src'),
    ...files('scripts').filter((file) => file.endsWith('.ts')),
    'eslint.config.js',
    'README.md',
    'AGENTS.md',
    'REVIEW.md',
  ];

  it('no file names a rule that was renamed away', () => {
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return STALE.some((name) => text.includes(name));
    });
    expect(offenders).toEqual([]);
  });

  it('the rules that comments send the reader to exist in eslint.config.js', () => {
    const config = readFileSync('eslint.config.js', 'utf8');
    for (const name of CURRENT)
      expect(config, name).toMatch(new RegExp(`(?:const|let) ${name}\\b`));
  });
});
