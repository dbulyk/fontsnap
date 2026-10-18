import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONTENT_SCRIPT_FILE, EXTENSION_PAGES } from '../../src/shared/constants';
import type { BundleKind } from '../../vite.shared';
import { WASM_MESSAGE } from './src-only';
import { hasAllowedMediaExtension, isAllowedDistMedia, isStaticAsset } from './static-assets';
import { expectedManifest } from './expected-manifest';
import { VENDOR_FILES, vendorDistProblems, vendorFileProblem, type VendorFile } from './vendor';
import { importsRuntime, scriptProblems } from './wasm-scan';

/** True when the source uses ES module syntax (import/export statements, import.meta). */
export function findEsmSyntax(source: string): boolean {
  return (
    /\bimport\.meta\b/.test(source) ||
    /(?:^|[;}\n])\s*(?:import\s*[\w{*"']|export\s*[{*\w])/.test(source)
  );
}

type Manifest = Record<string, unknown>;

/** What the bundler emitted: the main build and the content-script build, file → kind. */
export interface Bundles {
  main: Readonly<Record<string, BundleKind>>;
  content: Readonly<Record<string, BundleKind>>;
}

/**
 * The files the Vite builds emitted and what each is (written by bundleFilesPlugin in
 * vite.shared.ts), for the production or e2e mode.
 */
export function readBundleFiles(e2e: boolean, reportsDir = 'reports'): Bundles {
  const mode = e2e ? 'e2e' : 'production';
  const read = (part: 'main' | 'content') => {
    const path = join(reportsDir, `bundle-${mode}-${part}.json`);
    if (!existsSync(path)) throw new Error(`${path} not found: run the build first`);
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, BundleKind>;
  };
  return { main: read('main'), content: read('content') };
}

function filesBelow(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(dir, path) : [path];
  });
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL = /data:(?:[a-z0-9.+-]+\/[a-z0-9.+*-]+|(?=[;,]))[;,]/i;
const STYLESHEET = /^assets\/[A-Za-z0-9_.-]+\.css$/;
const CHUNK_FILE = /^(?:assets\/)?[A-Za-z0-9_.-]+\.js$/;
const WORKER_FILE = /^assets\/[A-Za-z0-9_.-]+\.js$/;

/**
 * Every file in the build must be on the allowlist: a chunk or worker chunk the bundler built from
 * a source entry (.js), a stylesheet in assets/, a page or the manifest, a locale messages file or a
 * PNG icon the manifest names. Nothing is allowed because of what it is not (no list of extensions
 * to refuse): a file of any other kind, whatever the bundler called it, could be loaded with
 * `<script src>` (Chrome does not look at the MIME type of a classic script) and run in an extension
 * page. Add a kind here deliberately, with a reason.
 */
function disallowedFiles(
  dir: string,
  bundles: Bundles,
  pages: readonly string[],
  icons: readonly string[],
  vendor: ReadonlyMap<string, VendorFile>,
): string[] {
  // A Map: a file called `constructor` or `__proto__` is not a kind the report did not give it.
  const kinds = new Map([...Object.entries(bundles.main), ...Object.entries(bundles.content)]);
  const problems: string[] = [];
  const isStyle = (file: string) => kinds.get(file) === 'asset' && STYLESHEET.test(file);
  for (const file of filesBelow(dir)) {
    const kind = kinds.get(file);
    // The vendored runtime and model are the only exception: the table in vendor.ts names them, and
    // vendorDistProblems() checks their bytes.
    if (/\.wasm$/i.test(file) && !vendor.has(file)) {
      problems.push(`${file}: ${WASM_MESSAGE}`);
      continue;
    }
    const allowed =
      file === 'manifest.json' ||
      (kind === 'asset' && vendor.has(file)) ||
      (kind === 'asset' && pages.includes(file)) ||
      (kind === 'chunk' && CHUNK_FILE.test(file)) ||
      (kind === 'worker' && WORKER_FILE.test(file)) ||
      isStyle(file) ||
      (kind === 'asset' && hasAllowedMediaExtension(file)) ||
      (kind === undefined && file.startsWith('_locales/') && isStaticAsset(file)) ||
      (kind === undefined && icons.includes(file));
    if (!allowed) {
      problems.push(
        `${file}: not an allowed file (the build may hold chunks, stylesheets in assets/, the pages of EXTENSION_PAGES and the manifest, locale messages, the manifest icons, the media listed in ALLOWED_MEDIA and the pinned vendor files of scripts/lib/vendor.ts; to ship a font or an image add its type to ALLOWED_MEDIA in scripts/lib/static-assets.ts, see "Allow a media type" in README.md)`,
      );
    }
  }
  for (const [file, kind] of kinds) {
    if (kind === 'asset' && hasAllowedMediaExtension(file) && existsSync(join(dir, file))) {
      if (!isAllowedDistMedia(file, readFileSync(join(dir, file)))) {
        problems.push(
          `${file}: does not start like its file type (a medium must be what its name says)`,
        );
      }
    }
  }
  for (const icon of icons) {
    const path = join(dir, icon);
    if (existsSync(path) && !readFileSync(path).subarray(0, 8).equals(PNG_SIGNATURE)) {
      problems.push(`${icon}: not a PNG file`);
    }
  }
  for (const file of filesBelow(dir).filter((name) => /^_locales\/.*\.json$/.test(name))) {
    try {
      const messages = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
      if (typeof messages !== 'object' || messages === null || Array.isArray(messages)) {
        problems.push(`${file}: not a JSON object of messages`);
      }
    } catch {
      problems.push(`${file}: not valid JSON`);
    }
  }
  const content = Object.entries(bundles.content);
  if (
    content.length !== 1 ||
    content[0]?.[0] !== CONTENT_SCRIPT_FILE ||
    content[0][1] !== 'chunk'
  ) {
    problems.push(
      `the content-script build must be exactly { ${CONTENT_SCRIPT_FILE}: chunk }, found ${JSON.stringify(bundles.content)}`,
    );
  }
  return problems;
}

/** Built scripts, stylesheets and pages that carry a data: URL: the bytes of some file inlined past every check. */
function dataUrls(dir: string): string[] {
  return filesBelow(dir)
    .filter((file) => /\.(?:js|css|html)$/.test(file))
    .filter((file) => DATA_URL.test(readFileSync(join(dir, file), 'utf8')))
    .map(
      (file) =>
        `${file}: contains a data: URL (an inlined file: ?inline, a small asset, an imported data: module)`,
    );
}

/**
 * Static imports of built scripts (`from"./x.js"`, `import"../ort/x.mjs"`) that point at a file the build does not
 * have. The vendored runtime is imported as `../ort/ort.wasm.min.mjs`, which is right for a chunk in assets/ only: the
 * same import in a script at the root would leave the extension and fail at run time, with no other check noticing.
 */
function unresolvedImports(dir: string): string[] {
  return filesBelow(dir)
    .filter((file) => file.endsWith('.js'))
    .flatMap((file) => {
      const text = readFileSync(join(dir, file), 'utf8');
      return [...text.matchAll(/\b(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)].flatMap(
        (match) => {
          const specifier = match[1] ?? '';
          const target = posix.join(posix.dirname(file), specifier);
          return existsSync(join(dir, target))
            ? []
            : [`${file}: imports ${specifier}, which is not in the build (${target})`];
        },
      );
    });
}

/**
 * WebAssembly bytes or settings that name other code in a built script (scripts/lib/wasm-scan.ts). The pinned vendor
 * files are the only exception, by exact path and only while their bytes are the pinned ones (otherwise they are scanned
 * like any other script, besides being reported by vendorDistProblems).
 */
function scriptContentProblems(dir: string, vendor: ReadonlyMap<string, VendorFile>): string[] {
  const importers: string[] = [];
  const problems = filesBelow(dir)
    .filter((file) => /\.m?js$/.test(file))
    .flatMap((file) => {
      const bytes = readFileSync(join(dir, file));
      const pinned = vendor.get(file);
      if (pinned !== undefined && vendorFileProblem(file, bytes, pinned) === undefined) return [];
      const text = bytes.toString('latin1');
      if (importsRuntime(text)) importers.push(file);
      return scriptProblems(file, text);
    });
  // exactly one chunk (the one with src/result/model.ts) imports the runtime, so exactly one may configure it
  if (importers.length !== 1) {
    problems.push(
      `exactly one script of the build imports the vendored runtime (../ort/ort.wasm.min.mjs), found ${String(importers.length)}: ${importers.join(', ') || 'none'}`,
    );
  }
  return problems;
}

/** <script> tags in built pages that are inline, external or do not point at a chunk the bundler emitted. */
function strayScripts(dir: string, chunks: ReadonlySet<string>): string[] {
  return filesBelow(dir)
    .filter((file) => file.endsWith('.html'))
    .flatMap((page) => {
      const html = readFileSync(join(dir, page), 'utf8');
      return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap((match) => {
        const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1] ?? '')?.[1];
        if (src === undefined)
          return [`${page}: inline <script> (the CSP forbids it, and it escapes every check)`];
        const target = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)
          ? src
          : posix.join(dirname(page), src);
        return chunks.has(target)
          ? []
          : [`${page}: <script src="${src}"> is not a chunk the bundler emitted`];
      });
    });
}

/**
 * The HTML pages a manifest names, in every field that can name one. A page the manifest names but
 * EXTENSION_PAGES does not list is a page nobody declared (and the build would not have it).
 */
export function manifestPages(manifest: Manifest): string[] {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const named = (value: unknown): string[] => (typeof value === 'string' ? [value] : []);
  const resources = Array.isArray(manifest['web_accessible_resources'])
    ? (manifest['web_accessible_resources'] as unknown[]).flatMap((entry) =>
        strings(record(entry)['resources']),
      )
    : [];
  return [
    ...named(record(manifest['action'])['default_popup']),
    ...named(record(manifest['options_ui'])['page']),
    ...named(manifest['options_page']),
    ...named(record(manifest['side_panel'])['default_path']),
    ...Object.values(record(manifest['chrome_url_overrides'])).flatMap(named),
    ...named(manifest['devtools_page']),
    ...named(record(manifest['background'])['page']),
    ...strings(record(manifest['sandbox'])['pages']),
    ...resources.filter((resource) => /\.html?$/i.test(resource)),
  ];
}

/** A key's value only if the object has the key itself: `constructor`, `__proto__` ... are not manifest keys. */
const own = (record: Manifest, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const show = (value: unknown): string => (value === undefined ? 'nothing' : JSON.stringify(value));

function manifestProblems(actual: Manifest, expected: Manifest): string[] {
  const problems: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (isDeepStrictEqual(own(actual, key), own(expected, key))) continue;
    problems.push(
      `manifest.${key}: expected ${show(own(expected, key))}, found ${show(own(actual, key))}`,
    );
  }
  return problems;
}

/**
 * Sanity-checks a built extension directory and returns human-readable problems.
 * The whole manifest is compared with the hand-written expected manifest (expected-manifest.ts), so any capability
 * that reaches the shipped file by whatever route (src/manifest.ts, Vite plugin, config, hand edit) is caught:
 * nothing is allowed beyond it, and the e2e build adds only its loopback host permission.
 */
export function verifyDist(
  dir: string,
  options: {
    e2e: boolean;
    version: string;
    bundles: Bundles;
    pages?: readonly string[];
    /** The pinned vendor files; only tests pass their own. */
    vendor?: ReadonlyMap<string, VendorFile>;
  },
): string[] {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return [`${manifestPath} not found; run the build first`];

  let actual: Manifest;
  try {
    actual = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    return [`${manifestPath} is not valid JSON: ${String(error)}`];
  }
  // The hand-written release manifest (not buildManifest(): a wrong src/manifest.ts must not pass its own check);
  // the e2e build adds its loopback host permission and nothing else.
  const expected: Manifest = {
    ...expectedManifest(options.version),
    ...(options.e2e ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
  };
  const problems = manifestProblems(actual, expected);
  const chunks = new Set(
    Object.entries(options.bundles.main)
      .filter(([, kind]) => kind === 'chunk')
      .map(([file]) => file),
  );
  const pages = options.pages ?? Object.values(EXTENSION_PAGES);
  for (const page of new Set(manifestPages(actual))) {
    if (!pages.includes(page)) {
      problems.push(
        `manifest page ${page} is not in EXTENSION_PAGES (src/shared/constants.ts): declare it there`,
      );
    }
  }
  const icons = Object.values(expected['icons'] as Record<string, string>);
  const vendor = options.vendor ?? VENDOR_FILES;
  problems.push(
    ...disallowedFiles(dir, options.bundles, pages, icons, vendor),
    ...vendorDistProblems(dir, filesBelow(dir), vendor),
    ...dataUrls(dir),
    ...strayScripts(dir, chunks),
    ...unresolvedImports(dir),
    ...scriptContentProblems(dir, vendor),
  );

  const files = [
    (expected['background'] as { service_worker: string }).service_worker,
    ...pages,
    ...icons,
    `_locales/${String(expected['default_locale'])}/messages.json`,
    CONTENT_SCRIPT_FILE,
  ];
  for (const file of files) {
    if (!existsSync(join(dir, file)))
      problems.push(`missing file referenced by the extension: ${file}`);
  }

  const contentPath = join(dir, CONTENT_SCRIPT_FILE);
  if (existsSync(contentPath) && findEsmSyntax(readFileSync(contentPath, 'utf8'))) {
    problems.push(
      `${CONTENT_SCRIPT_FILE} uses ES module syntax but is injected as a classic script`,
    );
  }
  return problems;
}
