import { describe, expect, it } from 'vitest';
import { PROTOTYPE_NAMES } from './helpers/media';
import {
  ALLOWED_VITE_KEYS,
  configKeyPaths,
  unexpectedConfigKeys,
} from '../../scripts/lib/vite-config-keys';

const plugin = () => ({ name: 'x' });

describe('configKeyPaths', () => {
  it('lists full key paths; empty objects, arrays, functions and values are leaves', () => {
    expect(
      configKeyPaths({
        root: 'src',
        plugins: [plugin()],
        css: { postcss: {} },
        worker: { format: 'iife', plugins: () => [] },
        build: {
          modulePreload: { polyfill: false },
          rolldownOptions: { output: { format: 'es' } },
        },
      }).sort(),
    ).toEqual(
      [
        'root',
        'plugins',
        'css.postcss',
        'worker.format',
        'worker.plugins',
        'build.modulePreload.polyfill',
        'build.rolldownOptions.output.format',
      ].sort(),
    );
  });

  it('reports rollupOptions, the old name Vite keeps for it, as rolldownOptions', () => {
    expect(configKeyPaths({ build: { rollupOptions: { output: { banner: 'x' } } } })).toEqual([
      'build.rolldownOptions.output.banner',
    ]);
  });

  it('does not look inside the entries of rolldownOptions.input', () => {
    expect(
      configKeyPaths({
        build: {
          rolldownOptions: { input: { popup: 'a.html', options: 'b.html' } },
        },
      }),
    ).toEqual(['build.rolldownOptions.input']);
  });
});

describe('unexpectedConfigKeys', () => {
  const GOOD = {
    root: 'src',
    base: './',
    envDir: false,
    publicDir: false,
    plugins: [plugin()],
    worker: { format: 'iife', plugins: () => [] },
    css: { postcss: {}, transformer: 'postcss' },
    resolve: { tsconfigPaths: false },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      target: 'chrome120',
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      sourcemap: false,
      rolldownOptions: {
        input: { popup: 'p.html' },
        output: {
          format: 'iife',
          name: 'x',
          entryFileNames: 'x.js',
          codeSplitting: false,
        },
      },
    },
  };

  it('accepts the shape of the real configurations', () => {
    expect(unexpectedConfigKeys(GOOD)).toEqual([]);
  });

  // The worker pipeline has its own rolldown options, whose banner/intro/outro/plugins end up in a
  // chunk the build then calls a worker.
  it.each([
    ['worker banner', { worker: { rolldownOptions: { output: { banner: 'alert(1)' } } } }],
    ['worker intro', { worker: { rolldownOptions: { output: { intro: 'alert(1)' } } } }],
    ['worker outro', { worker: { rolldownOptions: { output: { outro: 'alert(1)' } } } }],
    ['worker rollup plugins', { worker: { rollupOptions: { plugins: [plugin()] } } }],
    ['worker rolldown plugins', { worker: { rolldownOptions: { plugins: [plugin()] } } }],
    ['worker.format other keys', { worker: { entryFileNames: 'x' } }],
    ['resolve.alias', { resolve: { alias: { a: 'b' } } }],
    ['resolve.conditions', { resolve: { conditions: ['x'] } }],
    ['css.preprocessorOptions', { css: { preprocessorOptions: { scss: {} } } }],
    ['css.postcss plugins', { css: { postcss: { plugins: [plugin()] } } }],
    ['css.lightningcss', { css: { lightningcss: { visitor: {} } } }],
    ['css.modules', { css: { modules: {} } }],
    ['define', { define: { x: '1' } }],
    ['assetsInclude', { assetsInclude: ['**/*.x'] }],
    ['build.lib', { build: { lib: { entry: 'x' } } }],
    ['output banner in a build', { build: { rolldownOptions: { output: { banner: 'x' } } } }],
    ['build plugins', { build: { rolldownOptions: { plugins: [plugin()] } } }],
  ])('refuses %s', (_name, extra) => {
    const bad = unexpectedConfigKeys({ ...GOOD, ...extra });
    expect(bad.length).toBeGreaterThan(0);
  });

  it('names the path that is not allowed', () => {
    expect(
      unexpectedConfigKeys({
        ...GOOD,
        worker: {
          ...GOOD.worker,
          rolldownOptions: { output: { banner: 'x' } },
        },
      }),
    ).toEqual(['worker.rolldownOptions.output.banner']);
  });

  it('keeps the allowlist free of anything that could carry code into a chunk', () => {
    for (const path of ALLOWED_VITE_KEYS) {
      expect(path, path).not.toMatch(
        /(?:^|\.)(banner|footer|intro|outro|define|alias|inject|external|lib|ssr)(?:\.|$)/,
      );
    }
    // Plugins: the build's own and the worker pipeline's, both pinned by name in vite-configs.test.ts.
    expect(ALLOWED_VITE_KEYS.filter((path) => path.endsWith('plugins')).sort()).toEqual([
      'plugins',
      'worker.plugins',
    ]);
  });
});

describe('unexpectedConfigKeys and prototype names', () => {
  it.each(PROTOTYPE_NAMES)('refuses a key named %s, at the top and nested', (name) => {
    const top = JSON.parse(`{"${name}":1}`) as object;
    const nested = JSON.parse(`{"build":{"${name}":1}}`) as object;
    expect(unexpectedConfigKeys(top), name).toEqual([name]);
    expect(unexpectedConfigKeys(nested), name).toEqual([`build.${name}`]);
  });

  it('does not read the allowlist through a plain object', () => {
    expect(Array.isArray(ALLOWED_VITE_KEYS)).toBe(true);
    expect(unexpectedConfigKeys({ root: 'src' })).toEqual([]);
  });
});
