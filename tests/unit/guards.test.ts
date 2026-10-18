import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import {
  collectEslint,
  collectScripts,
  collectTooling,
  collectWorkflows,
  contextOf,
  effectiveEslint,
  expandEslintContext,
  readSnapshot,
} from '../../scripts/lib/guards';
import {
  codeOutsideKnownAreas,
  disallowedPublicFiles,
  filesInNodeModules,
  disallowedSrcFiles,
  inlineScriptsInSrcHtml,
  PACKAGE_KEYS_RULE,
  misplacedToolConfigs,
  programFilesOutsideSrc,
  SRC_FILE_RULE,
  symlinksInRepo,
  unexpectedPackageKeys,
  viteConfigImports,
} from '../../scripts/lib/layout';
import { inspectPrettier } from '../../scripts/lib/prettier-guard';
import { listRepoFiles, listSourceFiles } from '../../scripts/lib/source-scan';
import { STATIC_ASSET_RULE } from '../../scripts/lib/static-assets';
import { lockfileProblems, nonRegistrySpecifiers, REGISTRY_RULE } from '../../scripts/lib/packages';
import { parseTsconfig } from '../../scripts/lib/tsconfig';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { findUnpinnedUses } from '../../scripts/lib/workflow-lint';

// Every guard is compared with a plain JSON file in tests/guard-snapshots/ (read with fs, so
// `vitest -u` cannot touch them). A mismatch is not a bug in the test: something that protects the
// project changed.
const HOW =
  'A guard changed. If that is deliberate: run `npm run guards:update`, review `git diff tests/guard-snapshots`, and explain the change in the pull request (see AGENTS.md).';

describe('guard snapshots', () => {
  it('package.json scripts, engines, overrides', () => {
    expect(collectScripts(), HOW).toEqual(readSnapshot('scripts'));
  });

  it('every workflow, composite action and the dependabot config (aliases resolved)', () => {
    expect(collectWorkflows(), HOW).toEqual(readSnapshot('workflows'));
  });

  it('effective Vitest, Playwright (what it loads, local and CI), tsconfig and Prettier state, and the small steering files', async () => {
    expect(await collectTooling(), HOW).toEqual(readSnapshot('tooling'));
  });

  it('effective ESLint config of each context, with rule options', async () => {
    expect(await collectEslint(), HOW).toEqual(readSnapshot('eslint'));
  });
});

describe('every file is covered by a guard', () => {
  const files = listSourceFiles('.');

  it('every linted file maps to a snapshotted context and has exactly that context’s effective config', async () => {
    const snapshot = readSnapshot('eslint');
    const eslint = new ESLint();
    const problems: string[] = [];
    for (const file of files) {
      const context = contextOf(file);
      const expected = expandEslintContext(snapshot, context);
      if (context.startsWith('unknown:')) {
        problems.push(
          `${file}: code outside src/, tests/, scripts/ and the repository root. Extension code lives under src/.`,
        );
      } else if (expected === undefined) {
        problems.push(
          `${file}: no guard snapshot for context "${context}". Add it deliberately: run \`npm run guards:update\`, review the new context in \`git diff tests/guard-snapshots\`, and explain it in the pull request.`,
        );
      } else if (!isDeepStrictEqual(await effectiveEslint(eslint, file), expected)) {
        problems.push(
          `${file}: its effective ESLint config differs from context "${context}". ${HOW}`,
        );
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('every TypeScript file is type-checked by a tsconfig', () => {
    const inPrograms = new Set(
      ['tsconfig.src.json', 'tsconfig.node.json'].flatMap((file) => {
        const parsed = parseTsconfig(`${process.cwd()}/${file}`);
        return parsed.fileNames.map((name) => name.slice(process.cwd().length + 1));
      }),
    );
    const missing = files.filter((file) => file.endsWith('.ts') && !inPrograms.has(file));
    expect(missing, 'files no tsconfig includes (an exclude would hide them from tsc)').toEqual([]);
  });

  it('every GitHub action is pinned to a full commit SHA with a version comment (aliases resolved)', () => {
    const yaml = Object.keys(collectWorkflows() as Record<string, unknown>).filter(
      (file) => !file.endsWith('dependabot.yml'),
    );
    expect(yaml.length).toBeGreaterThan(0);
    for (const file of yaml) expect(findUnpinnedUses(readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

describe('extension code lives where the guards look', () => {
  const files = listRepoFiles('.');

  it('has no code outside src/, tests/, scripts/ and the repository root', () => {
    expect(codeOutsideKnownAreas(files)).toEqual([]);
  });

  it('has every file of the src program under src/ (nothing imported from scripts/, lib/, ...)', () => {
    expect(programFilesOutsideSrc('tsconfig.src.json')).toEqual([]);
  });

  it('has no symbolic link anywhere (a link into src/ would hide where the code really lives)', () => {
    expect(symlinksInRepo('.')).toEqual([]);
  });

  it('has no repository file below a node_modules directory', () => {
    expect(filesInNodeModules(files)).toEqual([]);
  });

  it('repeats no page path outside the declared list: every consumer imports EXTENSION_PAGES', () => {
    const consumers = files.filter(
      (file) =>
        (file.startsWith('src/') || file.startsWith('scripts/') || /^vite[^/]*\.ts$/.test(file)) &&
        file !== 'src/shared/constants.ts',
    );
    const repeated = consumers.filter((file) =>
      Object.values(EXTENSION_PAGES).some((page) => readFileSync(file, 'utf8').includes(page)),
    );
    expect(repeated).toEqual([]);
  });

  it('has only .ts, .html and .css files in src/ (the bundler takes any file it is pointed at)', () => {
    expect(disallowedSrcFiles(files), SRC_FILE_RULE).toEqual([]);
  });

  it('has no script in a page of src/ other than <script type="module" src="./file.ts">', () => {
    expect(inlineScriptsInSrcHtml('.', files)).toEqual([]);
  });

  it('has only package.json fields on the allowlist (dependencies are fine; tool fields are not)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
    expect(unexpectedPackageKeys(pkg), PACKAGE_KEYS_RULE).toEqual([]);
  });

  it('takes every dependency from the npm registry (package.json specifiers and package-lock.json resolved)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
    const lock: unknown = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    expect([...nonRegistrySpecifiers(pkg), ...lockfileProblems(lock)], REGISTRY_RULE).toEqual([]);
  });

  it('runs only vendored code when Vite loads its configuration: vite, node: built-ins and these files', () => {
    expect(viteConfigImports(['vite.config.ts', 'vite.content.config.ts'])).toEqual({
      files: [
        'scripts/lib/src-only.ts',
        // the pinned vendor files (onnxruntime-web runtime, model): the template's WebAssembly exception
        'scripts/lib/vendor.ts',
        'src/manifest.ts',
        'src/shared/constants.ts',
        'vite.config.ts',
        'vite.content.config.ts',
        'vite.shared.ts',
      ],
      external: ['node:crypto', 'node:fs', 'node:path', 'vite'],
    });
  });

  it('has no code or page in public/, which the build copies as is', () => {
    expect(disallowedPublicFiles(files), STATIC_ASSET_RULE).toEqual([]);
  });

  it('keeps ESLint, Prettier, TypeScript, Vite, package and ignore configuration at the repository root', () => {
    expect(misplacedToolConfigs(files)).toEqual([]);
  });

  it('gives every formattable file the same Prettier config and does not ignore it (except snapshotted files)', async () => {
    const { mismatched, ignored } = await inspectPrettier('.', files);
    expect(
      mismatched,
      'files for which Prettier resolves another config than the root one',
    ).toEqual([]);
    // What format:check skips is pinned in tooling.json (prettier.ignoredFiles); nothing under src or tests/unit may be in it.
    expect(ignored.filter((file) => /^(src|tests\/(unit|e2e))\//.test(file))).toEqual([]);
  });
});
