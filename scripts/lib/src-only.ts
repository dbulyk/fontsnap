import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { ORT_EXTERNAL } from './vendor';

// The TypeScript program is not the module graph of the build: Vite also follows <script src> in
// HTML, new Worker(new URL(...)), ?raw/?url imports, CSS @import and dynamic import(). This plugin
// looks at what the bundler really loads, so extension code cannot come from outside src/.

const root = resolve(import.meta.dirname, '../..');

export interface SrcOnlyDirs {
  srcDir: string;
  nodeModulesDir: string;
}

const inside = (real: string, dir: string) => real.startsWith(dir + sep);

function realDir(dir: string): string | undefined {
  return existsSync(dir) ? realpathSync(dir) : undefined;
}

export const WASM_MESSAGE =
  'WebAssembly is intentionally not supported by this template (it needs wasm-unsafe-eval in the extension CSP); see "WebAssembly" in README.md';

/** Why a `.wasm` file (any query: ?init, ?url, ...) may not be part of the bundle, or undefined. */
export function findWasm(id: string): string | undefined {
  const file = id.replace(/[?#].*$/, '');
  return /\.wasm$/i.test(file) ? `${file}: ${WASM_MESSAGE}` : undefined;
}

/**
 * Why module `id` may not be part of the bundle, or undefined if it may. An allowlist: virtual
 * modules of the bundler (`\0…`) and files whose real path (symlinks resolved, query and hash
 * removed) is under src/ or the dependencies directory. A URL (https:, data:, file:), a bare name
 * that resolved to nothing, a file elsewhere, or a node_modules directory inside src/ is refused.
 */
export function findOutsideSrc(id: string, dirs: SrcOnlyDirs): string | undefined {
  if (id.startsWith('\0')) return undefined;
  const file = id.replace(/[?#].*$/, '');
  if (!isAbsolute(file)) {
    return `${id} is not a file (a URL or an unknown module), so it is not code from src/`;
  }
  const real = existsSync(file) ? realpathSync(file) : file;
  const src = realDir(dirs.srcDir);
  if (src !== undefined && inside(real, src)) {
    return real
      .slice(src.length + 1)
      .split(sep)
      .includes('node_modules')
      ? `${file} is below a node_modules directory inside src/`
      : undefined;
  }
  const modules = realDir(dirs.nodeModulesDir);
  if (modules !== undefined && inside(real, modules)) return undefined;
  return `${file} resolves to ${real}, which is outside src/`;
}

// The bundler resolves data: URL imports itself, past resolveId and load.
const DATA_URL_IMPORT = /\b(?:from|import)\s*\(?\s*["'`]data:/;

const CSS_FILE = /\.(?:css|pcss|scss|sass|less|styl)(?:[?#].*)?$/;

/** The specifiers of the local `@import` rules in CSS text (remote and data: URLs are not files). */
export function cssImportSpecifiers(css: string): string[] {
  const pattern = /@import(?![\w-])\s*(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s"')]+))/gi;
  return [...css.matchAll(pattern)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((specifier) => specifier !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(specifier));
}

/**
 * Paths written with Vite's `?inline` query (`new URL('./a.png?inline', import.meta.url)`,
 * `url(a.png?inline)`, `<img src="a.png?inline">`): that query makes Vite embed the file as a data:
 * URL whatever the inlining limit, so no asset reaches the bundle check. Literal paths only.
 */
export function inlineQueryPaths(text: string): string[] {
  if (!text.includes('inline')) return [];
  return [...text.matchAll(/["'(`]\s*([^"'()`\s?#]+)\?(?:[^"'()`\s]*&)?inline\b/g)].map(
    (match) => match[1] ?? '',
  );
}

type Resolve = (
  source: string,
  importer: string,
) => Promise<{ id: string; external?: unknown } | null>;

/**
 * postcss-import reads @import-ed files itself, past resolveId and load, so the @import rules of a
 * stylesheet are followed here, through nested stylesheets, and every file found is checked.
 */
async function checkCssImports(
  resolve: Resolve,
  check: (id: string) => void,
  code: string,
  file: string,
  seen: Set<string>,
): Promise<void> {
  for (const specifier of cssImportSpecifiers(code)) {
    const resolved = await resolve(specifier, file);
    if (!resolved || resolved.external === true) continue;
    check(resolved.id);
    const target = resolved.id.replace(/[?#].*$/, '');
    if (!seen.has(target) && CSS_FILE.test(target) && existsSync(target)) {
      seen.add(target);
      await checkCssImports(resolve, check, readFileSync(target, 'utf8'), target, seen);
    }
  }
}

/** Fails the build for any resolved or loaded module outside src/; also add it to `worker.plugins`. */
export function srcOnlyPlugin(dirs: Partial<SrcOnlyDirs> = {}): Plugin {
  const effective: SrcOnlyDirs = {
    srcDir: dirs.srcDir ?? join(root, 'src'),
    nodeModulesDir: dirs.nodeModulesDir ?? join(root, 'node_modules'),
  };
  const check = (id: string) => {
    const wasm = findWasm(id);
    if (wasm !== undefined) throw new Error(wasm);
    const problem = findOutsideSrc(id, effective);
    if (problem !== undefined) {
      throw new Error(`${problem}. Extension code must live under src/ (see AGENTS.md).`);
    }
  };
  let viteRoot = root;
  return {
    name: 'src-only',
    enforce: 'pre',
    // new URL(..., import.meta.url), CSS url() and <img src> are read by Vite itself (fs + emitFile),
    // past resolveId and load. Every such file becomes an asset of the bundle, so the assets are
    // checked by where they came from. An asset below the inlining limit would become a data: URL
    // and never show up there; with the limit at 0 every asset is a file.
    config: () => ({ build: { assetsInlineLimit: 0 } }),
    configResolved(config) {
      viteRoot = config.root;
      if (config.build.assetsInlineLimit !== 0) {
        throw new Error(
          'src-only needs build.assetsInlineLimit 0, so that every asset is checked.',
        );
      }
      // Library mode inlines every asset as a data: URL whatever the limit, past generateBundle.
      if (config.build.lib !== false) {
        throw new Error('src-only does not support build.lib; build an IIFE with rollupOptions.');
      }
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset') continue;
        for (const name of file.originalFileNames) check(resolve(viteRoot, name));
      }
    },
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved?.external === true) {
        // The one external module is the vendored onnxruntime-web runtime (scripts/lib/vendor.ts); the build
        // copies it byte for byte and verify-dist pins its sha256.
        if (resolved.id === ORT_EXTERNAL) return resolved;
        throw new Error(
          `${resolved.id} is an external module; extension code is bundled from src/.`,
        );
      }
      if (resolved) check(resolved.id);
      return resolved;
    },
    load(id) {
      check(id);
      return null;
    },
    async transform(code, id) {
      const file = id.replace(/[?#].*$/, '');
      if (DATA_URL_IMPORT.test(code)) {
        throw new Error(`${file} imports a data: URL; code must be a file under src/.`);
      }
      if (!id.startsWith('\0') && isAbsolute(file)) {
        for (const path of inlineQueryPaths(code)) {
          // Root-relative (/a.png) or relative to the module; an absolute file path is checked as is.
          if (path.startsWith('/')) check(path);
          check(path.startsWith('/') ? join(viteRoot, path) : resolve(dirname(file), path));
        }
      }
      if (!CSS_FILE.test(id)) return null;
      const resolveFrom: Resolve = (source, importer) =>
        this.resolve(source, importer, { skipSelf: true });
      await checkCssImports(resolveFrom, check, code, file, new Set());
      return null;
    },
  };
}
