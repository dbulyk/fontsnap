import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import {
  loadConfigFromFile,
  resolveConfig,
  type PluginOption,
  type ResolvedConfig,
  type UserConfig,
} from 'vite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { unexpectedConfigKeys } from '../../scripts/lib/vite-config-keys';
import {
  ORT_EXTERNAL,
  ORT_SPECIFIER,
  VENDOR_FILES,
  type VendorFile,
} from '../../scripts/lib/vendor';
import { pageEntries, sharedConfig, vendorPlugin } from '../../vite.shared';

// The src-only guard (scripts/lib/src-only.ts) works only where it is plugged in: the main build,
// the worker pipeline and the content-script build. These tests load the real configurations, so
// removing it from one place, or adding another way to copy files into the build, fails here.

const root = resolve(import.meta.dirname, '../..');
const src = resolve(root, 'src');

async function load(file: string, mode: string): Promise<ResolvedConfig> {
  return resolveConfig({ configFile: resolve(root, file), logLevel: 'silent' }, 'build', mode);
}

async function names(options: PluginOption): Promise<string[]> {
  const resolved = await options;
  if (!resolved) return [];
  if (Array.isArray(resolved)) return (await Promise.all(resolved.map(names))).flat();
  return [resolved.name];
}

/** The configuration exactly as the file writes it, so the plugin lists are ours alone. */
async function written(file: string, mode: string): Promise<UserConfig> {
  const loaded = await loadConfigFromFile({ command: 'build', mode }, resolve(root, file));
  if (!loaded) throw new Error(`${file} not found`);
  return loaded.config;
}

const MODES = ['production', 'e2e'];

describe.each(MODES)('the Vite configurations in %s mode', (mode) => {
  let main: ResolvedConfig;
  let content: ResolvedConfig;
  let mainFile: UserConfig;
  let contentFile: UserConfig;
  beforeAll(async () => {
    [main, content, mainFile, contentFile] = await Promise.all([
      load('vite.config.ts', mode),
      load('vite.content.config.ts', mode),
      written('vite.config.ts', mode),
      written('vite.content.config.ts', mode),
    ]);
  });

  it('plugs src-only into the main build and the content-script build, first', async () => {
    for (const file of [mainFile, contentFile])
      expect((await names(file.plugins))[0]).toBe('src-only');
  });

  it('plugs src-only into the worker pipeline of BOTH builds (workers are bundled on their own)', async () => {
    for (const file of [mainFile, contentFile]) {
      expect(await names(file.worker?.plugins?.()), 'worker.plugins()').toEqual([
        'src-only',
        'worker-chunks',
      ]);
    }
  });

  it('has no plugin besides ours, which could copy files into the build', async () => {
    expect(await names(mainFile.plugins)).toEqual([
      'src-only',
      'extension-manifest',
      'vendor-files',
      'record-bundle-files',
    ]);
    expect(await names(contentFile.plugins)).toEqual(['src-only', 'record-bundle-files']);
  });

  // One entry per element of sharedConfig(): each must reach each resolved configuration.
  const PINS: Record<string, (config: ResolvedConfig) => unknown> = {
    'worker.format': (config) => config.worker.format,
    'css.postcss (inline options switch the search for postcss.config.* / .postcssrc* off)': (
      config,
    ) => config.css.postcss,
    'css.transformer': (config) => config.css.transformer,
    'css.lightningcss': (config) => config.css.lightningcss,
    'envDir (no .env files)': (config) => config.envDir,
    'resolve.tsconfigPaths': (config) => config.resolve.tsconfigPaths,
    base: (config) => config.base,
    'build.assetsInlineLimit': (config) => config.build.assetsInlineLimit,
    'build.sourcemap': (config) => config.build.sourcemap,
    'build.minify (terser, for the Chrome Web Store build)': (config) => config.build.minify,
    'build.target': (config) => config.build.target,
    'build.modulePreload': (config) => config.build.modulePreload,
    'build.lib': (config) => config.build.lib,
  };
  const EXPECTED: Record<string, unknown> = {
    'worker.format': 'iife',
    'css.postcss (inline options switch the search for postcss.config.* / .postcssrc* off)': {},
    'css.transformer': 'postcss',
    'css.lightningcss': undefined,
    'envDir (no .env files)': false,
    'resolve.tsconfigPaths': false,
    base: './',
    'build.assetsInlineLimit': 0,
    'build.sourcemap': false,
    'build.minify (terser, for the Chrome Web Store build)': 'terser',
    'build.target': 'chrome120',
    'build.modulePreload': { polyfill: false },
    'build.lib': false,
  };

  it.each(Object.keys(PINS))('keeps %s in both builds', (name) => {
    for (const [build, config] of [
      ['main', main],
      ['content', content],
    ] as const) {
      expect(PINS[name]?.(config), `${build}: ${name}`).toEqual(EXPECTED[name]);
    }
  });

  it('has a pin for every element of the shared base, and nothing else in it', () => {
    const base = sharedConfig();
    expect(Object.keys(base).sort()).toEqual(
      ['base', 'build', 'css', 'envDir', 'plugins', 'resolve', 'root', 'worker'].sort(),
    );
    expect(Object.keys(base.worker ?? {}).sort()).toEqual(['format', 'plugins']);
    expect(Object.keys(base.css ?? {}).sort()).toEqual(['postcss', 'transformer']);
    expect(Object.keys(base.resolve ?? {})).toEqual(['tsconfigPaths']);
    expect(Object.keys(base.build ?? {}).sort()).toEqual(
      ['assetsInlineLimit', 'minify', 'modulePreload', 'sourcemap', 'target'].sort(),
    );
  });

  // The files may write only the key PATHS of ALLOWED_VITE_KEYS (scripts/lib/vite-config-keys.ts):
  // define, resolve.alias, css.postcss.plugins, build.lib, a banner/intro/outro/plugins in the worker
  // pipeline or the build ... each needs a decision, so adding one fails here.
  it('writes only allowed key paths in the configuration files', () => {
    for (const [name, file] of [
      ['vite.config.ts', mainFile],
      ['vite.content.config.ts', contentFile],
    ] as const) {
      expect(unexpectedConfigKeys(file), name).toEqual([]);
    }
  });

  it('copies only public/ and treats no extra file type as an asset', () => {
    expect(main.publicDir).toBe(resolve(root, 'public'));
    expect(content.publicDir).toBe('');
    for (const file of [mainFile, contentFile]) {
      expect(file.assetsInclude, 'assetsInclude').toBeUndefined();
    }
    for (const config of [main, content]) {
      expect(config.assetsInclude('x.anything-else'), 'assetsInclude').toBe(false);
    }
  });

  it('builds every page of EXTENSION_PAGES, and only those pages, as HTML entries', () => {
    const given = main.build.rolldownOptions.input;
    const entries = typeof given === 'object' && !Array.isArray(given) ? given : {};
    const pages = Object.fromEntries(
      Object.entries(entries).filter(([, path]) => path.endsWith('.html')),
    );
    expect(pages).toEqual(
      Object.fromEntries(
        Object.entries(EXTENSION_PAGES).map(([name, page]) => [name, resolve(src, page)]),
      ),
    );
  });

  it('starts every build from an entry under src/', () => {
    const input = (config: ResolvedConfig) => {
      const given = config.build.rolldownOptions.input;
      return Object.values(typeof given === 'object' ? given : { entry: given });
    };
    for (const config of [main, content]) {
      expect(input(config).length).toBeGreaterThan(0);
      for (const entry of input(config))
        expect(String(entry).startsWith(src + sep), config.root).toBe(true);
    }
  });
});

// `vite build --configLoader runner` resolves a default configuration (css.postcss undefined) before
// it reads ours, and that search runs a postcss.config.js found from the working directory. The
// `bundle` loader reads our configuration first, so css.postcss: {} is in force.
describe('the config loader of the build scripts', () => {
  const vite = resolve(root, 'node_modules/vite/bin/vite.js');

  function runBuild(loader: string): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'loader-'));
    try {
      writeFileSync(join(dir, 'main.ts'), 'export {};');
      writeFileSync(
        join(dir, 'vite.config.mjs'),
        `export default { css: { postcss: {} }, logLevel: 'silent', build: { rolldownOptions: { input: 'main.ts' } } };`,
      );
      writeFileSync(
        join(dir, 'postcss.config.js'),
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'ran'))}, 'ran');\nexport default { plugins: {} };\n`,
      );
      writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
      execFileSync(
        process.execPath,
        [vite, 'build', '-c', 'vite.config.mjs', '--configLoader', loader],
        { cwd: dir, stdio: 'pipe' },
      );
      return existsSync(join(dir, 'ran'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not run a postcss.config.js from the working directory with the bundle loader', () => {
    expect(runBuild('bundle')).toBe(false);
  });

  it('would run it with the runner loader, which is why the scripts do not use that one', () => {
    expect(runBuild('runner')).toBe(true);
  });

  it('is what package.json and dev.ts say', () => {
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['build', 'build:e2e']) {
      expect(scripts.scripts[name], name).toContain('--configLoader bundle');
      expect(scripts.scripts[name], name).not.toContain('runner');
    }
    const dev = readFileSync(resolve(root, 'scripts/dev.ts'), 'utf8');
    expect(dev).toContain("'bundle'");
    expect(dev).not.toContain("'runner'");
  });
});

describe('pageEntries', () => {
  it('maps every page of EXTENSION_PAGES to its file under src/', () => {
    expect(
      pageEntries({ result: 'result/result.html', welcome: 'welcome/welcome.html' }, '/p/src'),
    ).toEqual({
      result: '/p/src/result/result.html',
      welcome: '/p/src/welcome/welcome.html',
    });
  });

  it('refuses a page called background: the service worker takes that input name', () => {
    expect(() => pageEntries({ background: 'background/background.html' })).toThrow(
      /may not have a page named 'background'.*service worker.*src\/shared\/constants\.ts/s,
    );
  });

  it('keeps background out of the declared list', () => {
    expect(Object.hasOwn(EXTENSION_PAGES, 'background')).toBe(false);
    expect(() => pageEntries()).not.toThrow();
  });

  it('keeps names that every object has as plain page names', () => {
    const pages = JSON.parse('{"__proto__":"a/a.html","constructor":"b/b.html"}') as Record<
      string,
      string
    >;
    expect(Object.keys(pageEntries(pages, '/p'))).toEqual(['__proto__', 'constructor']);
  });
});

describe('vendorPlugin', () => {
  const resolveId = vendorPlugin().resolveId as (this: unknown, source: string) => unknown;

  it('answers the one import of the onnxruntime-web entry point with the external runtime, and only that', () => {
    expect(resolveId.call({}, ORT_SPECIFIER)).toEqual({ id: ORT_EXTERNAL, external: true });
  });

  it.each([
    'onnxruntime-web',
    'onnxruntime-web/webgpu',
    'onnxruntime-web/wasm?url',
    'onnxruntime-web/wasm/',
    '../ort/ort.wasm.min.mjs',
    'onnxruntime-node',
    '',
  ])('leaves %j to the other resolvers', (source) => {
    expect(resolveId.call({}, source)).toBeNull();
  });

  it('runs before Vite resolves the package itself (or the package would be bundled)', () => {
    expect(vendorPlugin().enforce).toBe('pre');
  });

  // Stand-ins under the real paths: the real model is a Git LFS pointer in a checkout that did not pull it (the
  // checks job), and 47 MB are not needed to see what the plugin does with them.
  describe('emitting the pinned files', () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function standIns(change: Record<string, string> = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'vendor-plugin-'));
      roots.push(dir);
      const vendor = new Map<string, VendorFile>();
      for (const path of VENDOR_FILES.keys()) {
        const bytes = Buffer.from(`stand-in for ${path}`);
        vendor.set(path, {
          source: `src-${path}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        });
        mkdirSync(dirname(join(dir, `src-${path}`)), { recursive: true });
        writeFileSync(join(dir, `src-${path}`), change[path] ?? bytes);
      }
      return { dir, vendor };
    }

    function emit(options: { root: string; vendor: ReadonlyMap<string, VendorFile> }) {
      const emitted: { fileName: string; type: string; source: Buffer }[] = [];
      const generate = vendorPlugin(options).generateBundle as (this: unknown) => void;
      generate.call({
        emitFile: (file: { fileName: string; type: string; source: Buffer }) => {
          emitted.push(file);
        },
      });
      return emitted;
    }

    it('emits exactly the paths of the pinned list, as assets with the bytes of the source', () => {
      const { dir, vendor } = standIns();
      const emitted = emit({ root: dir, vendor });
      expect(emitted.map((file) => file.fileName).sort()).toEqual([...VENDOR_FILES.keys()].sort());
      expect(emitted.map((file) => file.fileName).sort()).toEqual([
        'model/meta.json',
        'model/model_fp16.onnx',
        'ort/ort-wasm-simd-threaded.mjs',
        'ort/ort-wasm-simd-threaded.wasm',
        'ort/ort.wasm.min.mjs',
      ]);
      expect(emitted.every((file) => file.type === 'asset')).toBe(true);
      expect(
        emitted.find((file) => file.fileName === 'ort/ort.wasm.min.mjs')?.source.toString(),
      ).toBe('stand-in for ort/ort.wasm.min.mjs');
    });

    it('fails the build on a changed byte, naming the file', () => {
      const { dir, vendor } = standIns({
        'ort/ort-wasm-simd-threaded.wasm': 'stand-in for ort/ort-wasm-simd-threaded.wasn',
      });
      expect(() => emit({ root: dir, vendor })).toThrow(
        /ort\/ort-wasm-simd-threaded\.wasm has sha256/,
      );
    });

    it('fails the build on a Git LFS pointer in place of the model, saying how to fix it', () => {
      const pointer =
        'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 1\n';
      const { dir, vendor } = standIns({ 'model/model_fp16.onnx': pointer });
      expect(() => emit({ root: dir, vendor })).toThrow(
        /model\/model_fp16\.onnx is a Git LFS pointer.*git lfs pull/,
      );
    });

    it('fails the build on a missing source', () => {
      const { vendor } = standIns();
      expect(() => emit({ root: join(tmpdir(), 'vendor-plugin-nowhere'), vendor })).toThrow(
        /not found/,
      );
    });
  });
});
