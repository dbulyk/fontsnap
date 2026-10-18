import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import ts from 'typescript';
import { CODE_FILE } from './source-scan';
import { isAllowedSrcFile, isStaticAsset } from './static-assets';
import { parseTsconfig } from './tsconfig';

// Extension code is src/ and only src/: the src lint rules, the coverage thresholds, the boundary
// rules and the Node-type isolation are all tied to that directory, while the bundler would take
// any imported file and everything under public/. These checks keep the two in step.

const AREAS = ['src', 'tests', 'scripts'];

/** Code files that live outside src/, tests/, scripts/ and the repository root. */
export function codeOutsideKnownAreas(files: readonly string[]): string[] {
  return files.filter((file) => {
    if (!CODE_FILE.test(file)) return false;
    const [first] = file.split('/');
    return file.includes('/') && !AREAS.includes(first ?? '');
  });
}

/** Files that git tracks (force-added) below a node_modules directory: ESLint, coverage and the file lists skip such paths, the bundler does not. */
export function filesInNodeModules(files: readonly string[]): string[] {
  return files.filter((file) => file.split('/').includes('node_modules'));
}

/**
 * Files that a tool reads by itself, from the directory it works in and upwards (or in every
 * directory): Vite (vite.config.*, .env*, the PostCSS config, tsconfig/jsconfig for each file),
 * PostCSS, browserslist, the compilers, ESLint, Prettier, npm. Their content is not code anyone
 * reviews as code, and some of them name plugins that run Node code at build time.
 */
const TOOL_CONFIG: RegExp[] = [
  /^eslint\.config\.[cm]?[jt]s$/,
  /^\.eslintrc(\..+)?$/,
  /^\.eslintignore$/,
  /^\.prettierrc(\..+)?$/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^\.prettierignore$/,
  /^\.editorconfig$/,
  /^[tj]sconfig(\..+)?\.json$/,
  /^package\.json$/,
  /^\.gitignore$/,
  /^\.npmrc$/,
  /^vite\.[a-z.]*config\.[cm]?[jt]s$/,
  /^vitest\.(config|workspace)\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^(?:rollup|rolldown|esbuild|webpack|parcel)\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
  /^\.postcssrc(\..+)?$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^babel\.config\.[cm]?[jt]s$/,
  /^\.babelrc(\..+)?$/,
  /^\.browserslistrc$/,
  /^\.swcrc$/,
  /^\.env(\..+)?$/,
];

/** The tool configuration this repository owns: root files, exactly. Add one deliberately. */
export const OWNED_TOOL_CONFIGS: readonly string[] = [
  'eslint.config.js',
  '.prettierrc.json',
  '.prettierignore',
  '.editorconfig',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.src.json',
  'tsconfig.node.json',
  'package.json',
  '.gitignore',
  'vite.config.ts',
  'vite.content.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
];

/** Tool configuration the repository does not own, or owns but keeps somewhere other than its root. */
export function misplacedToolConfigs(files: readonly string[]): string[] {
  return files.filter((file) => {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return TOOL_CONFIG.some((pattern) => pattern.test(name)) && !OWNED_TOOL_CONFIGS.includes(file);
  });
}

export const PACKAGE_KEYS = [
  'name',
  'version',
  'private',
  'license',
  'description',
  'type',
  'engines',
  'scripts',
  'dependencies',
  'devDependencies',
  'overrides',
];

export const PACKAGE_KEYS_RULE =
  'package.json fields are an allowlist (PACKAGE_KEYS in scripts/lib/layout.ts): runtime libraries go in ' +
  '`dependencies`, tools in `devDependencies`; other fields are refused because tools read their ' +
  'configuration from them (`postcss`, `browserslist`, `babel`, `imports`, ...). Add a field deliberately.';

/** package.json fields outside the allowlist (see PACKAGE_KEYS_RULE). */
export function unexpectedPackageKeys(pkg: Record<string, unknown>): string[] {
  return Object.keys(pkg).filter((key) => !PACKAGE_KEYS.includes(key));
}

/** What `src/` may hold. The bundler takes any file it is pointed at, and no guard looks inside the others. */
export const SRC_FILE_RULE =
  'src/ holds only .ts, .html and .css files (the guards lint, type-check and cover those) and the media ' +
  'listed in ALLOWED_MEDIA (scripts/lib/static-assets.ts, empty today). WebAssembly is intentionally not ' +
  'supported (see README.md); allow a medium by adding it to ALLOWED_MEDIA, which also opens the build gate.';

/** Files in src/ that are not on the allowlist (a .txt that a script could load, JSON, SVG, a dotfile config). */
export function disallowedSrcFiles(files: readonly string[]): string[] {
  return files.filter((file) => file.startsWith('src/') && !isAllowedSrcFile(file));
}

/** The one script a page of src/ may have, character for character. */
export const PAGE_SCRIPT = '<script type="module" src="./index.ts"></script>';

/**
 * Pages of src/ whose scripts are not exactly one `<script type="module" src="./index.ts"></script>`.
 * An inline module is bundled into a chunk without ESLint, tsc or coverage ever seeing it, and any
 * other `src` (another file, even one that only looks like media) puts that file into the page the
 * same way; the entry point `index.ts` is the only file that is linted, typed and covered as code.
 * A script mentioned in a comment is counted too.
 */
export function inlineScriptsInSrcHtml(root: string, files: readonly string[]): string[] {
  return files
    .filter((file) => file.startsWith('src/') && file.endsWith('.html'))
    .flatMap((file) => {
      const html = readFileSync(join(root, file), 'utf8');
      const tags = [...html.matchAll(/<script(?=[\s/>])/gi)].length;
      const exact = html.split(PAGE_SCRIPT).length - 1;
      return tags === 1 && exact === 1
        ? []
        : [
            `${file}: a page has exactly one script and it is exactly ${PAGE_SCRIPT} (found ${String(tags)} <script> tag(s), ${String(exact)} of them exact); inline or other scripts are bundled without lint, tsc or coverage`,
          ];
    });
}

/** Vite copies public/ into the build as is, so it may hold locale messages and icons, never code (see static-assets.ts). */
export function disallowedPublicFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) => file.startsWith('public/') && !isStaticAsset(file.slice('public/'.length)),
  );
}

/**
 * Symbolic links in the repository (they would let a path under src/ lead to code kept elsewhere):
 * what git records with mode 120000 (also where a checkout with core.symlinks=false left a plain
 * file), plus whatever the work tree holds as a link, including a new file git does not track yet.
 */
export function symlinksInRepo(root = '.'): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter((entry) => entry !== '');
  const recorded = git('ls-files', '-s', '-z')
    .filter((entry) => entry.startsWith('120000 '))
    .map((entry) => entry.slice(entry.indexOf('\t') + 1));
  const inWorkTree = [
    ...git('ls-files', '-z'),
    ...git('ls-files', '-z', '--others', '--exclude-standard'),
  ].filter((file) => {
    try {
      return lstatSync(join(root, file)).isSymbolicLink();
    } catch {
      return false; // deleted from the work tree
    }
  });
  return [...new Set([...recorded, ...inWorkTree])].sort();
}

/**
 * Files of the real TypeScript program of `tsconfig` (root files and everything they import) that
 * are not under src/. Libraries (node_modules, lib.d.ts) and JSON are not code of ours.
 */
export function programFilesOutsideSrc(tsconfig: string, cwd = process.cwd()): string[] {
  const parsed = parseTsconfig(join(cwd, tsconfig));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return program
    .getSourceFiles()
    .filter(
      (file) =>
        !program.isSourceFileDefaultLibrary(file) &&
        !program.isSourceFileFromExternalLibrary(file) &&
        !file.fileName.includes('/node_modules/') &&
        !file.fileName.endsWith('.json'),
    )
    .map((file) => file.fileName.slice(cwd.length + 1))
    .filter((file) => !file.startsWith('src/'))
    .sort();
}

/**
 * The files that run when Vite loads a configuration file (the relative imports, followed), and the
 * non-relative specifiers they import: only `vite` and `node:` built-ins belong there. Anything else
 * would run its code, with the developer's rights, every time the project is built.
 */
export function viteConfigImports(
  entries: readonly string[],
  cwd = process.cwd(),
): { files: string[]; external: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (files.has(file)) continue;
    files.add(file);
    const text = readFileSync(join(cwd, file), 'utf8');
    for (const { fileName: specifier } of ts.preProcessFile(text, true, true).importedFiles) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      const base = posix.join(dirname(file), specifier).replace(/\.[cm]?js$/, '');
      const found = [`${base}.ts`, `${base}/index.ts`, base].find(
        (candidate) => /\.[cm]?[jt]s$/.test(candidate) && existsSync(join(cwd, candidate)),
      );
      if (found !== undefined) queue.push(found);
    }
  }
  return { files: [...files].sort(), external: [...external].sort() };
}
