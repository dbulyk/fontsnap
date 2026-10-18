import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, UserConfig } from 'vite';
import { buildManifest } from './src/manifest';
import { EXTENSION_PAGES } from './src/shared/constants';
import { srcOnlyPlugin } from './scripts/lib/src-only';
import {
  ORT_EXTERNAL,
  ORT_SPECIFIER,
  ORT_VERSION,
  VENDOR_FILES,
  readVendorFile,
} from './scripts/lib/vendor';

const root = import.meta.dirname;

/** The e2e build lives in its own directory so it never ends up in a release zip. */
export function outDirFor(mode: string): string {
  return resolve(root, mode === 'e2e' ? 'dist-e2e' : 'dist');
}

/** package.json is the single source of the extension version. */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

export function manifestPlugin(options: { e2e: boolean }): Plugin {
  return {
    name: 'extension-manifest',
    generateBundle() {
      const manifest = buildManifest({ version: packageVersion(), e2e: options.e2e });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

/**
 * The HTML entries of the build, name → absolute file, from the one declared list of pages. The
 * service worker is built from src/background/index.ts under the input name `background`, so a page
 * may not take that name (it would silently replace the worker).
 */
export function pageEntries(
  pages: Readonly<Record<string, string>> = EXTENSION_PAGES,
  base: string = resolve(root, 'src'),
): Record<string, string> {
  if (Object.hasOwn(pages, 'background')) {
    throw new Error(
      "EXTENSION_PAGES may not have a page named 'background': that name is the service worker, built from src/background/index.ts, not a page (src/shared/constants.ts)",
    );
  }
  return Object.fromEntries(
    Object.entries(pages).map(([name, page]) => [name, resolve(base, page)]),
  );
}

/**
 * The vendored runtime and model (scripts/lib/vendor.ts, the template's one WebAssembly exception): copies
 * the pinned files into the build byte for byte (the build fails if their sha256 or size differ), and
 * answers the one import of the onnxruntime-web entry point with an external module next to the page
 * chunks, so the bundler never reads, rewrites or minifies the runtime.
 */
export function vendorPlugin(): Plugin {
  return {
    name: 'vendor-files',
    // before Vite's own resolver, which would find the package and bundle it
    enforce: 'pre',
    buildStart() {
      const installed = (
        JSON.parse(
          readFileSync(resolve(root, 'node_modules/onnxruntime-web/package.json'), 'utf8'),
        ) as {
          version: string;
        }
      ).version;
      if (installed !== ORT_VERSION) {
        throw new Error(
          `onnxruntime-web ${installed} is installed, FontSnap pins ${ORT_VERSION} (run npm ci)`,
        );
      }
    },
    resolveId(source) {
      return source === ORT_SPECIFIER ? { id: ORT_EXTERNAL, external: true } : null;
    },
    generateBundle() {
      for (const [path, entry] of VENDOR_FILES) {
        this.emitFile({ type: 'asset', fileName: path, source: readVendorFile(root, path, entry) });
      }
    },
  };
}

export const TARGET = 'chrome120';
export const SRC = resolve(root, 'src');
export const PUBLIC = resolve(root, 'public');

/** File names of the chunks the worker pipeline built (the main build then emits them as assets). */
const workerChunks = new Set<string>();

/** Runs in the worker pipeline and records its chunks, so verify-dist can tell them from copied files. */
export function workerChunksPlugin(): Plugin {
  return {
    name: 'worker-chunks',
    generateBundle(_options, bundle) {
      for (const [file, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') workerChunks.add(file);
      }
    },
  };
}

export type BundleKind = 'chunk' | 'asset' | 'worker';

/** What each emitted file is: built from an entry, built by the worker pipeline, or an asset. */
export function bundleKinds(
  bundle: Record<string, { type: 'chunk' | 'asset' }>,
): Record<string, BundleKind> {
  return Object.fromEntries(
    Object.entries(bundle)
      .map(([file, output]): [string, BundleKind] => [
        file,
        output.type === 'chunk' ? 'chunk' : workerChunks.has(file) ? 'worker' : 'asset',
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Everything that decides what Vite does with a file, for BOTH builds (main and content script), so
 * the pipelines cannot drift apart. Each element is pinned by tests/unit/vite-configs.test.ts:
 * - srcOnlyPlugin in the build and in the worker pipeline (workers are bundled on their own);
 * - inline PostCSS options, which switch off the search for postcss.config.* and .postcssrc*, so no
 *   Node code is loaded from a config file at build time;
 * - envDir: false (no .env files), no tsconfig `paths`, every asset a file (see src-only.ts).
 * `srcOnly` and `root` exist so that tests can build a throwaway project with the real base.
 */
export function sharedConfig(options: { srcOnly?: () => Plugin; root?: string } = {}): UserConfig {
  const srcOnly = options.srcOnly ?? (() => srcOnlyPlugin());
  return {
    root: options.root ?? SRC,
    base: './',
    envDir: false,
    plugins: [srcOnly()],
    // Workers are bundled by a pipeline of their own; one file, no shared chunks.
    worker: { format: 'iife', plugins: () => [srcOnly(), workerChunksPlugin()] },
    css: { postcss: {}, transformer: 'postcss' },
    resolve: { tsconfigPaths: false },
    build: {
      target: TARGET,
      assetsInlineLimit: 0,
      modulePreload: { polyfill: false },
      sourcemap: false,
      // The Chrome Web Store build is minified by terser (devDependency from npm).
      minify: 'terser',
    },
  };
}

/**
 * Records which files the bundler emitted, and what each is (chunk, worker chunk, asset), so
 * verify-dist can reject anything else in the build (a script copied from public/, a page or module
 * nobody bundled) and any asset that is not on its allowlist.
 */
export function bundleFilesPlugin(part: 'main' | 'content', mode: string): Plugin {
  return {
    name: 'record-bundle-files',
    buildStart() {
      workerChunks.clear();
    },
    writeBundle(_options, bundle) {
      mkdirSync(resolve(root, 'reports'), { recursive: true });
      writeFileSync(
        resolve(root, 'reports', `bundle-${mode}-${part}.json`),
        JSON.stringify(bundleKinds(bundle)),
      );
    },
  };
}
