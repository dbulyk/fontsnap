import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, mergeConfig } from 'vite';
import type { BuildOptions } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cssImportSpecifiers,
  findOutsideSrc,
  findWasm,
  inlineQueryPaths,
  srcOnlyPlugin,
} from '../../scripts/lib/src-only';
import { ORT_EXTERNAL } from '../../scripts/lib/vendor';
import { bundleKinds, sharedConfig, type BundleKind } from '../../vite.shared';

let root: string;
const fixtureRoots: string[] = [];

/** A throwaway project: src/, scripts/, node_modules/. Returns absolute paths by relative name. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'src-only-'));
  fixtureRoots.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

beforeEach(() => {
  root = project({
    'src/a.ts': 'export const a = 1;',
    'scripts/x.ts': 'export const x = 1;',
    'node_modules/dep/index.js': 'export const dep = 1;',
  });
  symlinkSync(join(root, 'scripts/x.ts'), join(root, 'src/link.ts'));
  symlinkSync(join(root, 'src/a.ts'), join(root, 'scripts/inner.ts'));
});
afterEach(() => {
  for (const dir of fixtureRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const dirs = () => ({
  srcDir: join(root, 'src'),
  nodeModulesDir: join(root, 'node_modules'),
});
const at = (name: string) => join(root, name);

describe('findOutsideSrc', () => {
  it.each([
    'src/a.ts',
    'src/a.ts?worker',
    'src/a.ts?raw',
    'src/a.ts#frag',
    'node_modules/dep/index.js',
  ])('allows %s', (name) => {
    expect(findOutsideSrc(at(name), dirs())).toBeUndefined();
  });

  it.each(['scripts/x.ts', 'scripts/x.ts?worker', 'scripts/x.ts?raw', 'scripts/x.ts?url#h'])(
    'rejects %s, whatever the query',
    (name) => {
      expect(findOutsideSrc(at(name), dirs())).toContain('outside src/');
    },
  );

  it('rejects a symlink inside src/ that points outside, by its real path', () => {
    expect(findOutsideSrc(at('src/link.ts'), dirs())).toContain(join(root, 'scripts', 'x.ts'));
  });

  it('allows a symlink outside src/ that points into src/ (the code is src code)', () => {
    expect(findOutsideSrc(at('scripts/inner.ts'), dirs())).toBeUndefined();
  });

  it.each(['\0vite/preload-helper', '\0vite/modulepreload-polyfill', '\0virtual:thing'])(
    'leaves the virtual module %j alone',
    (id) => {
      expect(findOutsideSrc(id, dirs())).toBeUndefined();
    },
  );

  it.each([
    'https://cdn.example/x.js',
    'data:text/javascript,alert(1)',
    'file:///etc/passwd',
    'vite/preload-helper',
    'some-package',
  ])(
    'rejects %j: not a file, so not code from src/ (an allowlist, not a list of schemes)',
    (id) => {
      expect(findOutsideSrc(id, dirs())).toContain('is not a file');
    },
  );

  it('rejects an absolute path that does not exist outside src/, allows one under src/', () => {
    for (const id of ['/no/such/file.ts', '//cdn.example/x.js', '/@vite/client']) {
      expect(findOutsideSrc(id, dirs()), id).toContain('outside src/');
    }
    expect(findOutsideSrc(at('src/not-yet.ts'), dirs())).toBeUndefined();
  });

  it('does not count a node_modules directory inside src/ as src code', () => {
    mkdirSync(at('src/popup/node_modules'), { recursive: true });
    writeFileSync(at('src/popup/node_modules/evil.ts'), 'export {};');
    expect(findOutsideSrc(at('src/popup/node_modules/evil.ts'), dirs())).toContain(
      'node_modules directory inside src/',
    );
  });

  it('rejects an absolute path to a real file outside src/', () => {
    expect(findOutsideSrc(at('scripts/x.ts'), dirs())).toBeDefined();
  });
});

describe('findWasm', () => {
  it.each([
    '/p/src/m.wasm',
    '/p/src/m.wasm?init',
    '/p/src/m.WASM',
    '/p/src/m.wasm#x',
    '/p/src/m.wasm?url',
  ])('recognizes %s as WebAssembly', (id) => {
    expect(findWasm(id)).toContain('intentionally not supported');
  });

  it.each(['/p/src/m.ts', '/p/src/wasm.ts', '/p/src/m.wasm.ts', '\0vite/x', '/p/src/a.css?init'])(
    'lets %s through',
    (id) => {
      expect(findWasm(id)).toBeUndefined();
    },
  );
});

describe('srcOnlyPlugin hooks', () => {
  const plugin = () => srcOnlyPlugin(dirs());
  const load = (id: string) =>
    (plugin().load as (this: unknown, id: string) => unknown).call({}, id);

  it('load throws for a module outside src/ and passes everything else on', () => {
    expect(() => load(at('scripts/x.ts'))).toThrow(/outside src\/.*lives? under src\//s);
    expect(load(at('src/a.ts'))).toBeNull();
    expect(load('\0virtual:thing')).toBeNull();
  });

  it('resolveId checks what the other resolvers found, and keeps their answer', async () => {
    type Resolve = (
      this: unknown,
      source: string,
      importer: string | undefined,
      options: object,
    ) => Promise<unknown>;
    const resolveId = plugin().resolveId as Resolve;
    const ctx = (resolved: unknown) => ({
      resolve: () => Promise.resolve(resolved),
    });
    const found = { id: at('src/a.ts'), external: false };
    expect(await resolveId.call(ctx(found), './a', at('src/b.ts'), {})).toBe(found);
    await expect(
      resolveId.call(
        ctx({ id: at('scripts/x.ts'), external: false }),
        '../scripts/x',
        at('src/b.ts'),
        {},
      ),
    ).rejects.toThrow(/outside src\//);
    expect(await resolveId.call(ctx(null), 'unknown', at('src/b.ts'), {})).toBeNull();
    const external = { id: 'https://cdn.example/x.js', external: true };
    await expect(
      resolveId.call(ctx(external), 'https://cdn.example/x.js', undefined, {}),
    ).rejects.toThrow(/external module/);
  });
});

// The one external module of the build is the vendored onnxruntime-web runtime (scripts/lib/vendor.ts, the template's
// WebAssembly exception). It is let through by its exact id; any other external module, however similar, still fails.
describe('srcOnlyPlugin: the single external exception', () => {
  type Resolve = (
    this: unknown,
    source: string,
    importer: string | undefined,
    options: object,
  ) => Promise<unknown>;
  /** What the plugin answers when the other resolvers found `resolved` for an import in src/. */
  const run = (resolved: unknown) =>
    (srcOnlyPlugin(dirs()).resolveId as Resolve).call(
      { resolve: () => Promise.resolve(resolved) },
      'anything',
      at('src/b.ts'),
      {},
    );

  it('lets the vendored runtime through, unchanged', async () => {
    const vendored = { id: ORT_EXTERNAL, external: true };
    expect(await run(vendored)).toBe(vendored);
  });

  it.each([
    '../ort/ort-wasm-simd-threaded.mjs',
    '../ort/ort.wasm.min.mjs?x',
    './ort/ort.wasm.min.mjs',
    '../ort/ort.wasm.min.js',
    '../ort/../ort/ort.wasm.min.mjs',
    '../model/model_fp16.onnx',
    'onnxruntime-web',
    'https://cdn.example.com/ort.wasm.min.mjs',
    '//cdn.example.com/ort.wasm.min.mjs',
    'node:fs',
    '/abs/ort.wasm.min.mjs',
  ])('still refuses the external module %s', async (id) => {
    await expect(run({ id, external: true })).rejects.toThrow(/external module/);
  });

  it('does not accept the vendored id for a module that is not external', async () => {
    await expect(run({ id: ORT_EXTERNAL, external: false })).rejects.toThrow(
      /not a file|outside src/,
    );
  });
});

describe('srcOnlyPlugin configuration and bundle hooks', () => {
  type Hook<A extends unknown[]> = (this: unknown, ...args: A) => unknown;
  const hookOf =
    (plugin: object) =>
    <A extends unknown[]>(name: string): Hook<A> => {
      const method: unknown = Reflect.get(plugin, name);
      return method as Hook<A>;
    };
  const hook = <A extends unknown[]>(name: string) => hookOf(srcOnlyPlugin(dirs()))<A>(name);
  const resolved = (build: object) => ({ root, build });

  it('forces every asset to be a file, so that none escapes as a data: URL', () => {
    expect(hook('config').call({})).toEqual({
      build: { assetsInlineLimit: 0 },
    });
  });

  it('refuses a configuration in which assets can still be inlined', () => {
    const configResolved = hook<[object]>('configResolved');
    expect(() =>
      configResolved.call({}, resolved({ assetsInlineLimit: 4096, lib: false })),
    ).toThrow(/assetsInlineLimit 0/);
    expect(() => configResolved.call({}, resolved({ assetsInlineLimit: 0, lib: {} }))).toThrow(
      /does not support build\.lib/,
    );
    expect(() =>
      configResolved.call({}, resolved({ assetsInlineLimit: 0, lib: false })),
    ).not.toThrow();
  });

  it('checks where each emitted asset came from, relative to the Vite root', () => {
    const plugin = hookOf(srcOnlyPlugin(dirs()));
    const configResolved = plugin<[object]>('configResolved');
    const generateBundle = plugin<[object, object]>('generateBundle');
    configResolved.call({}, resolved({ assetsInlineLimit: 0, lib: false }));
    const asset = (...originalFileNames: string[]) => ({
      type: 'asset',
      originalFileNames,
    });
    const chunk = { type: 'chunk', originalFileNames: undefined };
    expect(() =>
      generateBundle.call({}, {}, { a: asset('src/a.ts'), b: asset(), c: chunk }),
    ).not.toThrow();
    expect(() => generateBundle.call({}, {}, { a: asset('src/a.ts', 'scripts/x.ts') })).toThrow(
      /outside src\//,
    );
  });
});

describe('inlineQueryPaths', () => {
  it('finds paths written with the ?inline query, in code, CSS and HTML', () => {
    const text = [
      "new URL('../a/x.js?inline', import.meta.url)",
      'body { background: url(../b/p.png?inline); }',
      'background: url( "/c/q.png?v=1&inline" )',
      '<img src="../d/p.png?inline#frag">',
      'new URL(`../e/x.js?inline`, import.meta.url)',
    ].join('\n');
    expect(inlineQueryPaths(text)).toEqual([
      '../a/x.js',
      '../b/p.png',
      '/c/q.png',
      '../d/p.png',
      '../e/x.js',
    ]);
  });

  it('ignores text without the query', () => {
    expect(inlineQueryPaths("new URL('./a.png', import.meta.url); const inline = 1;")).toEqual([]);
    expect(inlineQueryPaths('url(./a.png?inlined)')).toEqual([]);
  });
});

/** What a throwaway project built with the real shared base produced. */
interface BuiltProject {
  files: string[];
  kinds: Record<string, BundleKind>;
  code: string;
  dir: string;
}

/** Builds `files` (relative to the project) with the real shared base, the way the extension build does. */
async function buildDetailed(
  files: Record<string, string> | ((dir: string) => Record<string, string>),
  entry: string,
  buildOptions: BuildOptions = {},
): Promise<BuiltProject> {
  // Do not delete these dirs in afterEach: Vite can still resolve HTML scripts after
  // build() rejects on an outside asset (CI: unhandled "Failed to resolve ./main.ts").
  const dir = mkdtempSync(join(tmpdir(), 'src-only-build-'));
  for (const [name, text] of Object.entries(typeof files === 'function' ? files(dir) : files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const plugin = () =>
    srcOnlyPlugin({
      srcDir: join(dir, 'src'),
      nodeModulesDir: join(dir, 'node_modules'),
    });
  const base = sharedConfig({ srcOnly: plugin, root: join(dir, 'src') });
  let kinds: Record<string, BundleKind> = {};
  const output = await build({
    ...mergeConfig(base, {
      plugins: [
        {
          name: 'kinds',
          generateBundle(_options: unknown, bundle: Record<string, { type: 'chunk' | 'asset' }>) {
            kinds = bundleKinds(bundle);
          },
        },
      ],
      build: {
        write: false,
        ...buildOptions,
        rolldownOptions: {
          input: join(dir, entry),
          ...buildOptions.rolldownOptions,
        },
      },
    }),
    configFile: false,
    logLevel: 'silent',
  });
  const results = (Array.isArray(output) ? output : [output]).flatMap((result) =>
    'output' in result ? result.output : [],
  );
  return {
    dir,
    kinds,
    files: results.map((file) => file.fileName),
    code: results.map((file) => (file.type === 'chunk' ? file.code : '')).join('\n'),
  };
}

async function buildProject(
  files: Record<string, string> | ((dir: string) => Record<string, string>),
  entry: string,
  buildOptions: BuildOptions = {},
): Promise<string[]> {
  return (await buildDetailed(files, entry, buildOptions)).files;
}

describe('real builds', () => {
  const page = (script: string) => `<!doctype html><html><body>${script}</body></html>`;

  it('builds a page whose scripts all live under src/', async () => {
    await expect(
      buildProject(
        {
          'src/index.html': page('<script type="module" src="./main.ts"></script>'),
          'src/main.ts': "import './style.css'; export const ok = 1;",
          'src/style.css': "@import './nested.css';",
          'src/nested.css': 'body { color: red; }',
        },
        'src/index.html',
      ),
    ).resolves.toContain('index.html');
  });

  it('fails a build whose HTML pulls a script from outside src/', async () => {
    await expect(
      buildProject(
        {
          'src/index.html': page('<script type="module" src="../scripts/extra.ts"></script>'),
          'scripts/extra.ts': "document.body.textContent = 'Words: ' + (1.5).toFixed(1);",
        },
        'src/index.html',
      ),
    ).rejects.toThrow(/outside src\//);
  });

  it('fails a build whose Worker comes from outside src/', async () => {
    await expect(
      buildProject(
        {
          'src/main.ts':
            "export const w = new Worker(new URL('../scripts/w.ts', import.meta.url), { type: 'module' });",
          'scripts/w.ts': 'self.postMessage(1);',
        },
        'src/main.ts',
      ),
    ).rejects.toThrow(/outside src\//);
  });

  it.each([
    ['a ?raw import', () => "import text from '../scripts/data.ts?raw'; export const t = text;"],
    ['a ?url import', () => "import url from '../scripts/data.ts?url'; export const u = url;"],
    ['an absolute path import', (dir: string) => `import '${join(dir, 'scripts', 'data.ts')}';`],
    ['a dynamic import', () => "export const lazy = () => import('../scripts/data');"],
    ['a CSS @import', () => "import './style.css';"],
    ['a CSS @import written without a space', () => "import './nospace.css';"],
    ['a CSS @import behind a nested stylesheet', () => "import './entry.css';"],
  ])('fails a build with %s of a file outside src/', async (name, main) => {
    await expect(
      buildProject(
        (dir) => ({
          'scripts/data.ts': 'export const d = 1;',
          'scripts/outside.css': 'body { color: red; }',
          'src/style.css': "@import '../scripts/outside.css';",
          'src/entry.css': "@import './style.css';",
          'src/nospace.css': '@import"../scripts/outside.css";',
          'src/main.ts': main(dir),
        }),
        'src/main.ts',
      ),
      name,
    ).rejects.toThrow(/outside src\//);
  });
});

/**
 * Assets are read by Vite itself (fs + emitFile), past resolveId and load, so each way to name one
 * is a row here. `p` is the directory the row points into: `../scripts` (outside src/) or
 * `./assets` (inside). The file exists in both places, tiny or larger than the 4 KB inlining limit.
 */
interface AssetCase {
  name: string;
  asset: string;
  html?: (p: string) => string;
  main?: (p: string) => string;
  css?: (p: string) => string;
}
const ASSET_CASES: AssetCase[] = [
  {
    name: 'new URL()',
    asset: 'extra.js',
    main: (p) => `export const u = new URL('${p}/extra.js', import.meta.url).href;`,
  },
  {
    name: 'new URL() with a template string',
    asset: 'extra.js',
    main: (p) =>
      `export const u = (n: string) => new URL(\`${p}/\${n}.js\`, import.meta.url).href;`,
  },
  {
    name: 'new URL() with ?inline',
    asset: 'extra.js',
    main: (p) => `export const u = new URL('${p}/extra.js?inline', import.meta.url).href;`,
  },
  {
    name: 'a CSS url() with ?inline',
    asset: 'pic.png',
    css: (p) => `body { background: url(${p}/pic.png?inline); }`,
  },
  {
    name: '<img src> with ?inline',
    asset: 'pic.png',
    html: (p) => `<img src="${p}/pic.png?inline" alt="">`,
  },
  {
    name: 'a CSS url()',
    asset: 'pic.png',
    css: (p) => `body { background: url(${p}/pic.png); }`,
  },
  {
    name: 'an @font-face url()',
    asset: 'f.woff2',
    css: (p) => `@font-face { font-family: f; src: url(${p}/f.woff2); }`,
  },
  {
    name: 'a CSS image-set()',
    asset: 'pic.png',
    css: (p) => `body { background: image-set(url(${p}/pic.png) 1x); }`,
  },
  {
    name: '<img src>',
    asset: 'pic.png',
    html: (p) => `<img src="${p}/pic.png" alt="">`,
  },
  {
    name: '<img srcset>',
    asset: 'pic.png',
    html: (p) => `<img srcset="${p}/pic.png 1x" alt="">`,
  },
  {
    name: '<link rel=icon>',
    asset: 'pic.png',
    html: (p) => `<link rel="icon" href="${p}/pic.png">`,
  },
  {
    name: '<link rel=stylesheet>',
    asset: 'x.css',
    html: (p) => `<link rel="stylesheet" href="${p}/x.css">`,
  },
  {
    name: '<link rel=modulepreload>',
    asset: 'm.js',
    html: (p) => `<link rel="modulepreload" href="${p}/m.js">`,
  },
  {
    name: '<link rel=manifest>',
    asset: 'm.json',
    html: (p) => `<link rel="manifest" href="${p}/m.json">`,
  },
  {
    name: '<source src>',
    asset: 'v.mp4',
    html: (p) => `<video><source src="${p}/v.mp4"></video>`,
  },
  {
    name: '<source srcset>',
    asset: 'pic.png',
    html: (p) => `<picture><source srcset="${p}/pic.png"></picture>`,
  },
  {
    name: '<video poster>',
    asset: 'pic.png',
    html: (p) => `<video poster="${p}/pic.png"></video>`,
  },
  {
    name: 'a JSON import',
    asset: 'data.json',
    main: (p) => `import data from '${p}/data.json'; export const d = data;`,
  },
  {
    name: 'import.meta.glob with a query',
    asset: 'extra.js',
    main: (p) =>
      `export const all = import.meta.glob('${p}/*.js', { query: '?url', eager: true });`,
  },
  {
    name: 'an ?inline CSS import',
    asset: 'x.css',
    main: (p) => `import css from '${p}/x.css?inline'; export const c = css;`,
  },
];
const SIZES: [string, number][] = [
  ['tiny', 0],
  ['larger than the inlining limit', 5000],
];

/** File text that is valid for the file's type and `padding` characters longer. */
function assetText(name: string, padding: number): string {
  const pad = 'x'.repeat(padding);
  if (name.endsWith('.css')) return `body { color: red; } /* ${pad} */`;
  if (name.endsWith('.json')) return `{ "k": "${pad}" }`;
  return `// ${pad}`;
}

function assetProject(row: AssetCase, padding: number, where: string): Record<string, string> {
  // HTML-only rows use an inline module so Vite does not keep a dangling resolve of
  // ./main.ts after an outside-asset failure (unhandled rejection once the temp dir is gone).
  const needsMain = row.main !== undefined || row.css !== undefined;
  const script = needsMain
    ? '<script type="module" src="./main.ts"></script>'
    : '<script type="module">export {};</script>';
  const body = `${row.html?.(where) ?? ''}${script}`;
  const imports = row.css ? "import './style.css';\n" : '';
  return {
    'src/index.html': `<!doctype html><html><body>${body}</body></html>`,
    ...(needsMain ? { 'src/main.ts': `${imports}${row.main?.(where) ?? 'export {};'}` } : {}),
    ...(row.css ? { 'src/style.css': row.css(where) } : {}),
    [`scripts/${row.asset}`]: assetText(row.asset, padding),
    [`src/assets/${row.asset}`]: assetText(row.asset, padding),
  };
}

describe('real builds: assets', () => {
  describe.each(SIZES)('%s', (_size, padding) => {
    it.each(ASSET_CASES)('fails a build with $name pointing outside src/', async (row) => {
      await expect(
        buildProject(assetProject(row, padding, '../scripts'), 'src/index.html'),
      ).rejects.toThrow(/outside src\//);
    });

    it.each(ASSET_CASES)('builds with $name pointing inside src/', async (row) => {
      await expect(
        buildProject(assetProject(row, padding, './assets'), 'src/index.html'),
      ).resolves.toContain('index.html');
    });
  });
});

describe('real builds: modules that are not files', () => {
  it('fails a build that imports a URL (an external module)', async () => {
    await expect(
      buildProject({ 'src/main.ts': "import 'https://cdn.example/x.js';" }, 'src/main.ts'),
    ).rejects.toThrow(/external module/);
  });

  it.each([
    "import 'data:text/javascript,globalThis.x=1';",
    'export { x } from `data:text/javascript,export const x = 1`;',
    "export const lazy = () => import('data:text/javascript,export const x = 1');",
  ])('fails a build that imports a data: URL: %s', async (code) => {
    await expect(buildProject({ 'src/main.ts': code }, 'src/main.ts')).rejects.toThrow(
      /imports a data: URL/,
    );
  });
});

describe('real builds: other ways in', () => {
  const outsideAsset = "export const u = new URL('../scripts/extra.js', import.meta.url).href;";

  it.each(SIZES)(
    'fails a build whose Worker from src/ names an asset outside src/ (%s)',
    async (_size, padding) => {
      await expect(
        buildProject(
          {
            'src/main.ts':
              "export const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });",
            'src/w.ts': `${outsideAsset}\nself.postMessage(u);`,
            'scripts/extra.js': assetText('extra.js', padding),
          },
          'src/main.ts',
        ),
      ).rejects.toThrow(/outside src\//);
    },
  );

  it('refuses a library build, which inlines every asset past the bundle check', async () => {
    await expect(
      buildProject({ 'src/main.ts': 'export {};' }, 'src/main.ts', {
        lib: { entry: 'main.ts', formats: ['iife'], name: 'content' },
      }),
    ).rejects.toThrow(/does not support build\.lib/);
  });

  it.each(SIZES)(
    'fails an IIFE build (the content script) with an asset outside src/ (%s)',
    async (_size, padding) => {
      await expect(
        buildProject(
          {
            'src/main.ts': outsideAsset,
            'scripts/extra.js': assetText('extra.js', padding),
          },
          'src/main.ts',
          { rolldownOptions: { output: { format: 'iife', name: 'content' } } },
        ),
      ).rejects.toThrow(/outside src\//);
    },
  );

  it.each([
    ['a script', 'scripts/entry.ts'],
    ['a page', 'scripts/entry.html'],
  ])('fails a build whose input is %s outside src/', async (_name, entry) => {
    await expect(
      buildProject(
        {
          'scripts/entry.ts': 'export const e = 1;',
          'scripts/entry.html': '<!doctype html><html><body></body></html>',
          'src/main.ts': 'export {};',
        },
        entry,
      ),
    ).rejects.toThrow(/outside src\//);
  });
});

describe('real builds: what the shared base switches off', () => {
  const contentBuild: BuildOptions = {
    rolldownOptions: {
      output: { format: 'iife', name: 'content', codeSplitting: false },
    },
  };

  it('fails a ?worker&inline worker that pulls code from outside src/ (glob), also in an IIFE build', async () => {
    await expect(
      buildProject(
        {
          'scripts/payload.ts': "console.log('payload from scripts', (1.5).toFixed(1));",
          'src/w.ts':
            "export const all = import.meta.glob('../scripts/payload.ts', { eager: true });",
          'src/register.ts':
            "import ContentWorker from './w?worker&inline';\nif (typeof Worker === 'function') new ContentWorker();",
        },
        'src/register.ts',
        contentBuild,
      ),
    ).rejects.toThrow(/outside src\//);
  });

  it('fails a worker whose own import leaves src/', async () => {
    await expect(
      buildProject(
        {
          'scripts/payload.ts': 'export const p = 1;',
          'src/w.ts': "import '../scripts/payload';",
          'src/register.ts': "import W from './w?worker&inline'; export const w = W;",
        },
        'src/register.ts',
        contentBuild,
      ),
    ).rejects.toThrow(/outside src\//);
  });

  it('does not run a PostCSS plugin named by a .postcssrc.json (or postcss.config.js) found from src/', async () => {
    for (const [name, config] of [
      ['src/.postcssrc.json', '{ "plugins": { "../scripts/pc.mjs": {} } }'],
      ['src/postcss.config.mjs', "export default { plugins: { '../scripts/pc.mjs': {} } };"],
    ] as const) {
      const built = await buildDetailed(
        (dir) => ({
          [name]: config,
          'scripts/pc.mjs': `import { writeFileSync } from 'node:fs';
export default () => ({ postcssPlugin: 'pc', Once() { writeFileSync(${JSON.stringify(join(dir, 'ran'))}, 'ran'); } });
export const postcss = true;`,
          'src/main.ts': "import './style.css'; export {};",
          'src/style.css': 'body { color: red; }',
        }),
        'src/main.ts',
      );
      expect(existsSync(join(built.dir, 'ran')), `${name} was loaded`).toBe(false);
    }
  });

  it('reads no .env file, so no VITE_ value reaches the bundle', async () => {
    const built = await buildDetailed(
      {
        'src/.env': 'VITE_SECRET=from-env-file',
        'src/main.ts': 'export const v = import.meta.env.VITE_SECRET;',
      },
      'src/main.ts',
    );
    expect(built.code).not.toContain('from-env-file');
  });
});

describe('real builds: workers and assets as the bundle report sees them', () => {
  it('records the chunk of a legitimate worker from src/ as a worker, not as a copied asset', async () => {
    const built = await buildDetailed(
      {
        'src/index.html':
          '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
        'src/main.ts':
          "export const w = new Worker(new URL('./w.ts', import.meta.url), { type: 'module' });",
        'src/w.ts': 'self.postMessage(1);',
      },
      'src/index.html',
    );
    const workers = Object.entries(built.kinds).filter(([, kind]) => kind === 'worker');
    expect(workers.map(([file]) => file)).toEqual([expect.stringMatching(/^assets\/w-.*\.js$/)]);
  });

  it('reports a script that new URL() copied from src/ as an asset (the dist allowlist refuses it)', async () => {
    const built = await buildDetailed(
      {
        'src/index.html':
          '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
        'src/main.ts': "export const u = new URL('./extra.txt', import.meta.url).href;",
        'src/extra.txt': "globalThis.document.title = 'x';",
      },
      'src/index.html',
    );
    const copied = Object.entries(built.kinds).filter(([file]) => file.endsWith('.txt'));
    expect(copied).toEqual([[expect.stringMatching(/^assets\/extra-.*\.txt$/), 'asset']]);
  });
});

describe('real builds: a runtime dependency (npm i some-lib)', () => {
  const dependency = (extra: Record<string, string> = {}): Record<string, string> => ({
    'node_modules/some-lib/package.json':
      '{ "name": "some-lib", "version": "1.0.0", "type": "module", "main": "index.js", "exports": "./index.js" }',
    'node_modules/some-lib/index.js':
      "import { helper } from './helper.js';\nexport const lib = (n) => 'lib-' + helper(n);\n",
    'node_modules/some-lib/helper.js': 'export const helper = (n) => String(n * 2);\n',
    'src/main.ts': "import { lib } from 'some-lib';\nglobalThis.value = lib(21);\n",
    'scripts/x.ts': 'export const x = 1;',
    ...extra,
  });

  it('bundles an ordinary ESM library from node_modules', async () => {
    const built = await buildDetailed(dependency(), 'src/main.ts');
    expect(built.code).toContain('lib-');
  });

  it('bundles a library that brings its own stylesheet', async () => {
    const built = await buildDetailed(
      dependency({
        'node_modules/some-lib/index.js': "import './style.css';\nexport const lib = () => 1;\n",
        'node_modules/some-lib/style.css': 'body { color: red; }',
      }),
      'src/main.ts',
    );
    expect(built.files.some((file) => file.endsWith('.css'))).toBe(true);
  });

  it('still refuses a library that reaches out of node_modules into the repository', async () => {
    await expect(
      buildProject(
        dependency({
          'node_modules/some-lib/index.js':
            "import '../../scripts/x.ts';\nexport const lib = () => 1;\n",
        }),
        'src/main.ts',
      ),
    ).rejects.toThrow(/outside src\//);
  });

  it('still refuses an import of the library by a path that leaves src/ for the repository', async () => {
    await expect(
      buildProject(dependency({ 'src/main.ts': "import '../scripts/x.ts';" }), 'src/main.ts'),
    ).rejects.toThrow(/outside src\//);
  });
});

describe('real builds: WebAssembly is intentionally not supported', () => {
  const WASM = '\0asm\x01\0\0\0';

  it.each([
    ['an ?init import', "import init from './m.wasm?init'; export const i = init;"],
    ['a plain import', "import url from './m.wasm?url'; export const u = url;"],
    ['new URL()', "export const u = new URL('./m.wasm', import.meta.url).href;"],
    ['a dynamic import', "export const lazy = () => import('./m.wasm?init');"],
  ])('fails a build with %s of a .wasm file, even one inside src/', async (_name, main) => {
    await expect(
      buildProject({ 'src/m.wasm': WASM, 'src/main.ts': main }, 'src/main.ts'),
    ).rejects.toThrow(/WebAssembly.*intentionally not supported/s);
  });

  it('also refuses a .wasm file that a library brings from node_modules', async () => {
    await expect(
      buildProject(
        {
          'node_modules/wasm-lib/package.json':
            '{ "name": "wasm-lib", "type": "module", "main": "index.js" }',
          'node_modules/wasm-lib/index.js':
            "export const u = new URL('./m.wasm', import.meta.url).href;\n",
          'node_modules/wasm-lib/m.wasm': WASM,
          'src/main.ts': "import { u } from 'wasm-lib'; globalThis.u = u;",
        },
        'src/main.ts',
      ),
    ).rejects.toThrow(/WebAssembly/);
  });
});

describe('cssImportSpecifiers', () => {
  it('finds local @import rules in every spelling and skips remote ones', () => {
    const css = [
      "@import './a.css';",
      '@import "b.css" layer(base);',
      '@import url(c.css);',
      '@import url("d.css") screen;',
      "@import url( 'e.css' );",
      '@import"nospace.css";',
      "@import'single.css';",
      '@importnot "a-rule.css";',
      "@import 'https://cdn.example/f.css';",
      '@import url(//cdn.example/g.css);',
      '@import "data:text/css,body{}";',
      'body { color: red; }',
    ].join('\n');
    expect(cssImportSpecifiers(css)).toEqual([
      './a.css',
      'b.css',
      'c.css',
      'd.css',
      'e.css',
      'nospace.css',
      'single.css',
    ]);
  });
});
