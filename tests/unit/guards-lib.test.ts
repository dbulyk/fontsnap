import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectScripts,
  collectSection,
  contextOf,
  effectiveEslint,
  expandEslintContext,
  readSnapshot,
  SECTIONS,
  stringify,
  writeGuards,
} from '../../scripts/lib/guards';

describe('stringify', () => {
  it('sorts keys, indents by two and ends with a newline', () => {
    expect(stringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{\n  "a": {\n    "c": "x",\n    "d": [1,2]\n  },\n  "b": 1\n}\n',
    );
  });

  it('prints arrays of objects one element per block and empty objects compactly', () => {
    expect(stringify({ steps: [{ run: 'a' }, { run: 'b' }], empty: {} })).toBe(
      '{\n  "empty": {},\n  "steps": [\n    {\n      "run": "a"\n    },\n    {\n      "run": "b"\n    }\n  ]\n}\n',
    );
  });

  it('prints each entry of rules, commonRules, ruleDifferences and plugins on one line', () => {
    const text = stringify({
      rules: { 'a/b': ['error', { x: 1, y: [2] }] },
      plugins: { p: { v: 1 } },
    });
    expect(text).toBe(
      '{\n  "plugins": {\n    "p": {"v":1}\n  },\n  "rules": {\n    "a/b": ["error",{"x":1,"y":[2]}]\n  }\n}\n',
    );
  });

  it('turns regexes and functions into text, drops undefined and makes absolute paths relative', () => {
    const text = stringify({
      grep: /a+b/i,
      fn: function named() {
        return 1;
      },
      gone: undefined,
      path: `${process.cwd()}/src/x.ts`,
    });
    expect(text).toContain('"grep": "/a+b/i"');
    expect(text).toContain('function named()');
    expect(text).not.toContain('gone');
    expect(text).toContain('"path": "<root>/src/x.ts"');
  });
});

describe('contextOf', () => {
  it.each([
    ['eslint.config.js', 'root-js'],
    ['vite.config.ts', 'root-ts'],
    ['eslint.config.d.ts', 'root-ts'],
    ['src/manifest.ts', 'src-root'],
    ['src/env.d.ts', 'src-dts'],
    ['src/shared/format.ts', 'src-format'],
    ['src/shared/settings.ts', 'src/shared'],
    ['src/result/app.ts', 'src/result'],
    ['src/result/model.ts', 'src-ort-model'],
    ['src/sidepanel/deep/x.ts', 'src/sidepanel'],
    ['tests/unit/guards.test.ts', 'tests/unit'],
    ['tests/unit/helpers/chrome-stub.ts', 'tests/unit/helpers'],
    ['tests/e2e/welcome.spec.ts', 'tests/e2e'],
    ['tests/support/x.ts', 'tests/support'],
    ['tests/setup.ts', 'tests-root'],
    ['scripts/zip.ts', 'scripts'],
    ['scripts/lib/dist.ts', 'scripts/lib'],
    ['lib/x.ts', 'unknown:lib/x.ts'],
    ['public/legacy.js', 'unknown:public/legacy.js'],
  ])('%s is in context %s', (file, context) => {
    expect(contextOf(file)).toBe(context);
  });
});

describe('effectiveEslint', () => {
  it('returns null for a file ESLint ignores, so the guard can name it', async () => {
    expect(await effectiveEslint(new ESLint(), 'node_modules/x/index.js')).toBeNull();
    expect(await effectiveEslint(new ESLint(), 'src/result/app.ts')).not.toBeNull();
  });
});

describe('plugin versions stay out of the ESLint snapshot', () => {
  // A patch release of a plugin must not turn every dependency update red; what a plugin enforces is
  // pinned by its rule names (hash) and by the enabled rules with their options.
  it('records name and rule hash of plugins and only the name of the parser', () => {
    const snapshot = readSnapshot('eslint') as {
      contexts: Record<
        string,
        { plugins: Record<string, object>; languageOptions: { parser: object } }
      >;
    };
    const context = snapshot.contexts['src/result'];
    expect(Object.keys(context?.plugins['@typescript-eslint'] ?? {}).sort()).toEqual([
      'name',
      'rulesHash',
    ]);
    expect(Object.keys(context?.languageOptions.parser ?? {})).toEqual(['name']);
    expect(JSON.stringify(snapshot)).not.toContain('"version"');
  });
});

describe('expandEslintContext', () => {
  const snapshot = {
    commonRules: { a: ['error'], b: ['warn'] },
    contexts: {
      ctx: {
        plugins: { p: {} },
        ruleDifferences: {
          b: null,
          c: ['error', { x: 1 }],
          a: ['error', 'never'],
        },
      },
    },
  };

  it('applies a context’s differences to the common rules: overrides, additions and removals', () => {
    expect(expandEslintContext(snapshot, 'ctx')).toEqual({
      plugins: { p: {} },
      rules: { a: ['error', 'never'], c: ['error', { x: 1 }] },
    });
  });

  it('returns undefined for a context the snapshot does not know', () => {
    expect(expandEslintContext(snapshot, 'nope')).toBeUndefined();
  });
});

describe('collectors and the committed snapshots', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('collectScripts keeps the tool-config keys of package.json', () => {
    const collected = collectScripts() as Record<string, unknown>;
    expect(Object.keys(collected)).toEqual(
      expect.arrayContaining(['scripts', 'engines', 'type', 'private']),
    );
  });

  it.each(SECTIONS)('collectSection(%s) matches the committed snapshot', async (section) => {
    expect(await collectSection(section)).toEqual(readSnapshot(section));
  });

  it('writeGuards regenerates exactly the committed files, byte for byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guards-'));
    dirs.push(dir);
    const written = await writeGuards(dir);
    expect(written.map((path) => path.slice(dir.length + 1))).toEqual(
      SECTIONS.map((name) => `${name}.json`),
    );
    for (const section of SECTIONS) {
      expect(readFileSync(join(dir, `${section}.json`), 'utf8')).toBe(
        readFileSync(join('tests/guard-snapshots', `${section}.json`), 'utf8'),
      );
    }
  });
});
