/**
 * The keys the Vite configuration files may write, as full key paths. An allowlist: anything else
 * (define, resolve.alias, css.postcss.plugins, build.lib, a banner/intro/outro/plugins anywhere,
 * `worker.rolldownOptions`, ...) can put code into a chunk or run it at build time, so adding a key
 * is a decision made here, in one place, and pinned by tests/unit/vite-configs.test.ts.
 */
export const ALLOWED_VITE_KEYS: readonly string[] = [
  'root',
  'base',
  'envDir',
  'publicDir',
  'plugins',
  'worker.format',
  'worker.plugins',
  'css.postcss',
  'css.transformer',
  'resolve.tsconfigPaths',
  'build.outDir',
  'build.emptyOutDir',
  'build.target',
  'build.assetsInlineLimit',
  'build.modulePreload.polyfill',
  'build.sourcemap',
  'build.minify',
  'build.rolldownOptions.input',
  'build.rolldownOptions.output.format',
  'build.rolldownOptions.output.name',
  'build.rolldownOptions.output.entryFileNames',
  'build.rolldownOptions.output.codeSplitting',
];

/** Objects whose entries are data (the named inputs), not options: they are one key. */
const OPAQUE = new Set(['build.rolldownOptions.input']);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Full key paths of a configuration object. Empty objects, arrays, functions and values are leaves.
 * `rollupOptions`, the old name Vite keeps for `rolldownOptions` (mergeConfig reports it), is
 * reported as `rolldownOptions`.
 */
export function configKeyPaths(config: object, prefix = ''): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const name = key === 'rollupOptions' ? 'rolldownOptions' : key;
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (!OPAQUE.has(path) && isPlainObject(value) && Object.keys(value).length > 0) {
      return configKeyPaths(value, path);
    }
    return [path];
  });
}

/** The key paths of `config` that are not on the allowlist. */
export function unexpectedConfigKeys(config: object): string[] {
  return configKeyPaths(config).filter((path) => !ALLOWED_VITE_KEYS.includes(path));
}
