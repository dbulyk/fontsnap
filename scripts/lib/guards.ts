import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { parse } from 'yaml';
import { inspectPrettier } from './prettier-guard';
import { parseTsconfig } from './tsconfig';
import vitestConfig from '../../vitest.config';
import { listRepoFiles, listSourceFiles } from './source-scan';

// Everything that guards the project is compared with a plain JSON snapshot in
// tests/guard-snapshots/. A change to a guard then shows in `git diff` and needs a deliberate
// `npm run guards:update` (see AGENTS.md), instead of a growing list of "forbidden" cases.

export const SNAPSHOT_DIR = 'tests/guard-snapshots';
export const SECTIONS = ['scripts', 'workflows', 'tooling', 'eslint'] as const;
export type Section = (typeof SECTIONS)[number];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Plain, deterministic data: regexes and functions as text, no undefined, absolute paths made relative. */
function normalize(value: unknown, root: string): Json {
  if (typeof value === 'string') return value.split(root).join('<root>');
  if (typeof value === 'function') return normalize(value.toString(), root);
  if (value instanceof RegExp) return normalize(String(value), root);
  if (Array.isArray(value)) return value.map((item) => normalize(item, root));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, inner]) => inner !== undefined)
        .map(([key, inner]) => [key, normalize(inner, root)] as const),
    );
  }
  return (value ?? null) as Json;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key] as Json)] as const),
  );
}

/**
 * Stable text of a snapshot: sorted keys, 2-space indent. Each entry of a "rules", "commonRules" or
 * "ruleDifferences" object is printed on a single line, so long selector lists stay one diff line.
 */
const ONE_LINE_PER_RULE = new Set(['rules', 'commonRules', 'ruleDifferences', 'plugins']);

export function stringify(value: unknown): string {
  const walk = (node: Json, indent: string, key: string): string => {
    if (typeof node !== 'object' || node === null) return JSON.stringify(node);
    if (Array.isArray(node)) {
      if (node.every((item) => typeof item !== 'object' || item === null))
        return JSON.stringify(node);
      const inner = `${indent}  `;
      return `[\n${node.map((item) => `${inner}${walk(item, inner, '')}`).join(',\n')}\n${indent}]`;
    }
    const inner = `${indent}  `;
    const entries = Object.entries(node).map(([name, item]) => {
      const text = ONE_LINE_PER_RULE.has(key) ? JSON.stringify(item) : walk(item, inner, name);
      return `${inner}${JSON.stringify(name)}: ${text}`;
    });
    return entries.length === 0 ? '{}' : `{\n${entries.join(',\n')}\n${indent}}`;
  };
  return `${walk(sortKeys(normalize(value, process.cwd())), '', '')}\n`;
}

const read = (path: string) => readFileSync(path, 'utf8');
const readOrAbsent = (path: string) => (existsSync(path) ? read(path) : '<absent>');

/** package.json fields that decide how every npm script runs. */
export function collectScripts(root = '.'): Json {
  const pkg = JSON.parse(read(join(root, 'package.json'))) as Record<string, unknown>;
  // Besides the scripts: anything in package.json that configures a tool for the whole repository.
  const {
    scripts,
    engines,
    type,
    private: isPrivate,
    overrides,
    prettier,
    eslintConfig,
    config,
  } = pkg;
  return normalize(
    { scripts, engines, type, private: isPrivate, overrides, prettier, eslintConfig, config },
    process.cwd(),
  );
}

function yamlFiles(root: string): string[] {
  const walk = (dir: string): string[] =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory()) return walk(path);
          return /\.ya?ml$/.test(entry.name) ? [path] : [];
        })
      : [];
  return walk('.github').sort();
}

/** Every workflow, composite action and the dependabot config, with anchors, aliases and merge keys resolved. */
export function collectWorkflows(root = '.'): Json {
  return Object.fromEntries(
    yamlFiles(root).map((file) => [file, parse(read(join(root, file)), { merge: true }) as Json]),
  );
}

// tsc stores these options as numbers; the snapshot shows their names.
const ENUM_OPTIONS: Record<string, Record<number, string>> = {
  target: ts.ScriptTarget,
  module: ts.ModuleKind,
  moduleResolution: ts.ModuleResolutionKind,
  moduleDetection: ts.ModuleDetectionKind,
  jsx: ts.JsxEmit,
  newLine: ts.NewLineKind,
};

const TSCONFIGS = ['tsconfig.json', 'tsconfig.src.json', 'tsconfig.node.json'];

const STRICT_FLAGS = [
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'strictBuiltinIteratorReturn',
  'noImplicitThis',
  'alwaysStrict',
  'useUnknownInCatchVariables',
];

/** Compiler options in effect after `extends` (as tsc resolves them), the `strict` sub-flags spelled out, and what the file includes. */
function effectiveTsconfig(root: string, file: string): Json {
  const parsed = parseTsconfig(join(process.cwd(), root, file));
  const options: Record<string, unknown> = { ...parsed.options };
  delete options['configFilePath'];
  delete options['pathsBasePath'];
  for (const [name, names] of Object.entries(ENUM_OPTIONS)) {
    const value = options[name];
    if (typeof value === 'number') options[name] = names[value] ?? value;
  }
  const raw = parsed.raw as { include?: unknown; exclude?: unknown; files?: unknown };
  const strict = Object.fromEntries(
    STRICT_FLAGS.map((flag) => [flag, options[flag] ?? options['strict'] ?? false]),
  );
  return normalize(
    { options, strict, include: raw.include, exclude: raw.exclude, files: raw.files },
    process.cwd(),
  );
}

/**
 * What Playwright really loads: the default export of playwright.config.ts, imported afresh with
 * and without CI in the environment (the reporters differ).
 */
async function playwrightDefault(ci: boolean): Promise<unknown> {
  const previous = process.env['CI'];
  if (ci) process.env['CI'] = 'true';
  else delete process.env['CI'];
  try {
    // The query makes every import evaluate the module again with the environment set above.
    const loaded = (await import(
      /* @vite-ignore */ `../../playwright.config.ts?ci=${String(ci)}`
    )) as {
      default: unknown;
    };
    return loaded.default;
  } finally {
    if (previous === undefined) delete process.env['CI'];
    else process.env['CI'] = previous;
  }
}

/** Test and build tool configs as they are in effect, plus the text of the small files that steer them. */
export async function collectTooling(root = '.'): Promise<Json> {
  const files = [
    '.nvmrc',
    '.npmrc',
    '.gitignore',
    '.prettierrc.json',
    '.prettierignore',
    'src/env.d.ts',
  ];
  const repoFiles = listRepoFiles(root);
  const declarations = repoFiles.filter((file) => /^src\/.*\.d\.ts$/.test(file));
  const { config, ignored } = await inspectPrettier(root, repoFiles);
  return normalize(
    {
      vitest: vitestConfig,
      playwright: { local: await playwrightDefault(false), ci: await playwrightDefault(true) },
      tsconfig: Object.fromEntries(TSCONFIGS.map((file) => [file, effectiveTsconfig(root, file)])),
      prettier: { config, ignoredFiles: ignored },
      files: Object.fromEntries(files.map((file) => [file, readOrAbsent(join(root, file))])),
      declarationFilesUnderSrc: declarations,
    },
    process.cwd(),
  );
}

/** The guard context of a file: files in one context must have the same effective ESLint config. */
export function contextOf(file: string): string {
  const parts = file.split('/');
  const [first, second] = parts;
  if (parts.length === 1) return file.endsWith('.js') ? 'root-js' : 'root-ts';
  if (first === 'src') {
    if (file === 'src/shared/format.ts') return 'src-format';
    if (file.endsWith('.d.ts')) return 'src-dts';
    return parts.length === 2 ? 'src-root' : `src/${String(second)}`;
  }
  if (first === 'tests') {
    if (file.startsWith('tests/unit/helpers/')) return 'tests/unit/helpers';
    return parts.length === 2 ? 'tests-root' : `tests/${String(second)}`;
  }
  if (first === 'scripts') return file.startsWith('scripts/lib/') ? 'scripts/lib' : 'scripts';
  return `unknown:${file}`;
}

interface Plugin {
  meta?: { name?: string; version?: string };
  rules?: Record<string, unknown>;
}

interface Effective {
  linterOptions?: unknown;
  processor?: unknown;
  plugins?: Record<string, Plugin>;
  languageOptions?: {
    sourceType?: unknown;
    ecmaVersion?: unknown;
    parserOptions?: unknown;
    parser?: { meta?: { name?: string; version?: string } };
  };
  rules?: Record<string, unknown>;
}

/** Name and a hash of the sorted rule names: a plugin that gains, loses or swaps rules shows up; its version does not (it would make every dependency update red). */
function describePlugin(plugin: Plugin): Json {
  const names = JSON.stringify(Object.keys(plugin.rules ?? {}).sort());
  return {
    name: plugin.meta?.name ?? null,
    rulesHash: createHash('sha256').update(names).digest('hex').slice(0, 16),
  };
}

const SEVERITY: ReadonlyMap<string, string> = new Map([
  ['0', 'off'],
  ['1', 'warn'],
  ['2', 'error'],
]);

/** The part of an effective ESLint config that matters: options, parser project and every enabled rule with its options. */
export async function effectiveEslint(eslint: ESLint, file: string): Promise<Json> {
  const config = (await eslint.calculateConfigForFile(file)) as Effective | undefined;
  // ESLint has no config for a file it ignores; null makes that visible instead of an exception.
  if (config === undefined) return null;
  const rules = Object.entries(config.rules ?? {}).flatMap(([name, entry]) => {
    const [severity, ...options] = Array.isArray(entry) ? (entry as unknown[]) : [entry];
    const level = SEVERITY.get(String(severity)) ?? String(severity);
    return level === 'off' ? [] : [[name, [level, ...options]] as const];
  });
  const { sourceType, ecmaVersion, parserOptions, parser } = config.languageOptions ?? {};
  return normalize(
    {
      linterOptions: config.linterOptions,
      // A processor can rewrite or drop every message; it must be visible, as text.
      processor: config.processor ?? null,
      plugins: Object.fromEntries(
        Object.entries(config.plugins ?? {}).map(([name, plugin]) => [
          name,
          describePlugin(plugin),
        ]),
      ),
      languageOptions: {
        sourceType,
        ecmaVersion,
        parserOptions,
        parser: { name: parser?.meta?.name ?? null },
      },
      rules: Object.fromEntries(rules),
    },
    process.cwd(),
  );
}

interface EffectiveEslint {
  linterOptions: Json;
  plugins: string[];
  languageOptions: Json;
  rules: Record<string, Json>;
}

/**
 * One representative file per context. Rules that every typed context has, identically, are stored once
 * under `commonRules`; a context lists only what differs (a rule's entry, or null when the rule is
 * off there), so a global change is one diff line and a per-context change shows in its context.
 */
export async function collectEslint(root = '.'): Promise<Json> {
  const eslint = new ESLint({ cwd: join(process.cwd(), root) });
  const representatives = new Map<string, string>();
  for (const file of listSourceFiles(root)) {
    const context = contextOf(file);
    if (!representatives.has(context)) representatives.set(context, file);
  }
  const names = [...representatives.keys()].sort();
  const full = new Map<string, EffectiveEslint>();
  for (const name of names) {
    const file = representatives.get(name) ?? '';
    full.set(name, (await effectiveEslint(eslint, file)) as unknown as EffectiveEslint);
  }
  // The un-typed JavaScript context is the outlier (it lacks every type-aware rule), so it must not
  // decide what is common; it lists its differences like any other context.
  const isTyped = (config: EffectiveEslint) =>
    typeof (config.languageOptions as { parserOptions?: { project?: unknown } }).parserOptions
      ?.project === 'string';
  const all = [...full.values()].filter(isTyped);
  const commonRules: Record<string, Json> = {};
  for (const [rule, entry] of Object.entries(all[0]?.rules ?? {})) {
    if (all.every((config) => JSON.stringify(config.rules[rule]) === JSON.stringify(entry))) {
      commonRules[rule] = entry;
    }
  }
  const contexts: Record<string, Json> = {};
  for (const name of names) {
    const config = full.get(name);
    if (!config) continue;
    const differences: Record<string, Json> = {};
    for (const rule of new Set([...Object.keys(commonRules), ...Object.keys(config.rules)])) {
      if (JSON.stringify(config.rules[rule]) !== JSON.stringify(commonRules[rule])) {
        differences[rule] = config.rules[rule] ?? null;
      }
    }
    const rest = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'rules'));
    contexts[name] = { ...(rest as Record<string, Json>), ruleDifferences: differences };
  }
  return { commonRules, contexts };
}

/** The full effective config of a context, rebuilt from the compact snapshot (see `collectEslint`). */
export function expandEslintContext(snapshot: unknown, context: string): Json | undefined {
  const { commonRules, contexts } = snapshot as {
    commonRules: Record<string, Json>;
    contexts: Record<
      string,
      { file: string; ruleDifferences: Record<string, Json> } & Record<string, Json>
    >;
  };
  const entry = contexts[context];
  if (!entry) return undefined;
  const rest = Object.fromEntries(
    Object.entries(entry).filter(([key]) => key !== 'ruleDifferences'),
  );
  const rules = Object.fromEntries(
    Object.entries({ ...commonRules, ...entry.ruleDifferences }).filter(
      ([, value]) => value !== null,
    ),
  );
  return { ...rest, rules };
}

const COLLECTORS: Record<Section, (root?: string) => Json | Promise<Json>> = {
  scripts: collectScripts,
  workflows: collectWorkflows,
  tooling: collectTooling,
  eslint: collectEslint,
};

export async function collectSection(section: Section): Promise<Json> {
  return COLLECTORS[section]();
}

export function readSnapshot(section: Section): unknown {
  return JSON.parse(read(join(SNAPSHOT_DIR, `${section}.json`)));
}

/** Regenerates every snapshot from the current configuration. Run only through `npm run guards:update`. */
export async function writeGuards(dir = SNAPSHOT_DIR): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const section of SECTIONS) {
    const path = join(dir, `${section}.json`);
    writeFileSync(path, stringify(await collectSection(section)));
    written.push(path);
  }
  return written;
}
