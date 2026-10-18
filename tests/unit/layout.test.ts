import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeOutsideKnownAreas,
  disallowedPublicFiles,
  filesInNodeModules,
  disallowedSrcFiles,
  inlineScriptsInSrcHtml,
  misplacedToolConfigs,
  OWNED_TOOL_CONFIGS,
  PACKAGE_KEYS_RULE,
  SRC_FILE_RULE,
  programFilesOutsideSrc,
  symlinksInRepo,
  unexpectedPackageKeys,
  viteConfigImports,
} from '../../scripts/lib/layout';
import { ALLOWED_MEDIA, MEDIA_SIGNATURES } from '../../scripts/lib/static-assets';
import { PROTOTYPE_NAMES, withMedia } from './helpers/media';

describe('codeOutsideKnownAreas', () => {
  it('allows code in src, tests, scripts and the repository root', () => {
    expect(
      codeOutsideKnownAreas([
        'src/popup/app.ts',
        'tests/e2e/support/x.ts',
        'scripts/lib/guards.ts',
        'vite.config.ts',
        'eslint.config.js',
        'README.md',
        'public/icons/icon-16.png',
      ]),
    ).toEqual([]);
  });

  it.each([
    'lib/popup-logic.ts',
    'public/legacy.js',
    'docs/snippet.mjs',
    'tools/build.cjs',
    '.github/scripts/x.js',
    'src2/popup.ts',
    'public/app.tsx',
  ])('flags code in %s', (file) => {
    expect(codeOutsideKnownAreas([file])).toEqual([file]);
  });
});

describe('misplacedToolConfigs', () => {
  it('allows exactly the tool configuration files this repository owns, at its root', () => {
    expect(misplacedToolConfigs(OWNED_TOOL_CONFIGS)).toEqual([]);
    expect(OWNED_TOOL_CONFIGS).toEqual(
      expect.arrayContaining(['vite.config.ts', 'vite.content.config.ts']),
    );
  });

  // The tools find these by themselves (Vite: .env*, postcss config, tsconfig for every file;
  // PostCSS: its config and plugins by name; and so on), so none may exist unless we own it.
  it.each([
    'lib/eslint.config.js',
    'src/eslint.config.mjs',
    'src/popup/.eslintrc.json',
    'src/.eslintrc',
    'src/.prettierrc.json',
    'src/.prettierrc',
    'src/prettier.config.js',
    'src/.prettierignore',
    'src/.editorconfig',
    'src/tsconfig.json',
    'src/popup/tsconfig.app.json',
    'src/popup/package.json',
    'src/.gitignore',
    'src/.npmrc',
    'src/vite.config.ts',
    'tests/playwright.config.ts',
    // found by Vite / PostCSS / browserslist / the compilers on their own, anywhere
    'src/.postcssrc.json',
    'src/.postcssrc',
    'src/.postcssrc.yml',
    'src/.postcssrc.ts',
    'src/postcss.config.js',
    'src/postcss.config.mts',
    'postcss.config.js',
    'postcss.config.cjs',
    '.postcssrc.json',
    'tailwind.config.js',
    'src/tailwind.config.ts',
    'babel.config.js',
    '.babelrc',
    '.babelrc.json',
    '.browserslistrc',
    'src/.browserslistrc',
    '.swcrc',
    'jsconfig.json',
    'src/jsconfig.json',
    '.env',
    '.env.production',
    '.env.local',
    'src/.env',
    'src/.env.e2e',
    'rollup.config.js',
    'rolldown.config.ts',
    // another Vite configuration beside ours: `vite build` would pick vite.config.js first
    'vite.config.js',
    'vite.config.mjs',
    'vite.other.config.ts',
  ])('flags %s', (file) => {
    expect(misplacedToolConfigs([file])).toEqual([file]);
  });

  it('does not flag source files that merely have similar names', () => {
    expect(
      misplacedToolConfigs(['vite.shared.ts', 'src/shared/env.ts', 'src/manifest.ts', 'README.md']),
    ).toEqual([]);
  });
});

describe('unexpectedPackageKeys', () => {
  it('allows dependencies: `npm i some-lib` is how a runtime library is added', () => {
    expect(
      unexpectedPackageKeys({
        name: 'x',
        version: '1',
        dependencies: { nanoid: '^5.0.0' },
        devDependencies: {},
      }),
    ).toEqual([]);
  });

  it('does not allow optionalDependencies or peerDependencies: a bundled extension has no use for them', () => {
    expect(unexpectedPackageKeys({ optionalDependencies: {}, peerDependencies: {} })).toEqual([
      'optionalDependencies',
      'peerDependencies',
    ]);
  });

  it('explains the allowlist when it refuses a field', () => {
    expect(PACKAGE_KEYS_RULE).toContain('allowlist');
    expect(PACKAGE_KEYS_RULE).toContain('dependencies');
    expect(PACKAGE_KEYS_RULE).toContain('PACKAGE_KEYS');
  });

  it('allows the fields this package.json has, and reports tool configuration hiding in others', () => {
    expect(
      unexpectedPackageKeys({
        name: 'x',
        version: '1',
        scripts: {},
        devDependencies: {},
        type: 'module',
      }),
    ).toEqual([]);
    expect(
      unexpectedPackageKeys({
        name: 'x',
        postcss: { plugins: {} },
        browserslist: ['last 1 version'],
        babel: {},
        imports: {},
        sideEffects: false,
        'lint-staged': {},
      }),
    ).toEqual(['postcss', 'browserslist', 'babel', 'imports', 'sideEffects', 'lint-staged']);
  });
});

describe('unexpectedPackageKeys and prototype names', () => {
  it.each(PROTOTYPE_NAMES)('refuses a package.json field named %s', (name) => {
    const pkg = JSON.parse(`{"name":"x","${name}":{}}`) as Record<string, unknown>;
    expect(unexpectedPackageKeys(pkg), name).toEqual([name]);
  });

  it.each(PROTOTYPE_NAMES)(
    'does not take a file named %s for a tool configuration we own',
    (name) => {
      expect(misplacedToolConfigs([name, `src/${name}`])).toEqual([]);
      expect(OWNED_TOOL_CONFIGS).not.toContain(name);
    },
  );
});

describe('disallowedSrcFiles', () => {
  it('allows TypeScript, HTML and CSS in src/', () => {
    expect(
      disallowedSrcFiles([
        'src/popup/app.ts',
        'src/env.d.ts',
        'src/options/options.html',
        'src/shared/styles.css',
        'tests/x.txt',
        'public/a.png',
      ]),
    ).toEqual([]);
  });

  it.each([
    'src/popup/extra.txt',
    'src/popup/data.json',
    'src/popup/logo.svg',
    'src/popup/logo.png',
    'src/popup/font.woff2',
    'src/popup/mod.wasm',
    'src/popup/app.js',
    'src/popup/app.mjs',
    'src/popup/app.tsx',
    'src/popup/style.scss',
    'src/popup/README',
    'src/.env',
    'src/.postcssrc.json',
    'src/popup/app.TS',
  ])('flags %s: the bundler would take it, but no guard looks inside it', (file) => {
    expect(disallowedSrcFiles([file])).toEqual([file]);
  });
});

describe('disallowedSrcFiles takes media from ALLOWED_MEDIA, the one list', () => {
  it.each([...MEDIA_SIGNATURES.keys()])(
    'flags a %s file until the list names its type',
    (extension) => {
      const file = `src/popup/logo.${extension}`;
      const wasListed = ALLOWED_MEDIA.has(extension);
      withMedia([extension], () => {
        expect(disallowedSrcFiles([file])).toEqual([]);
        expect(disallowedSrcFiles(['src/popup/logo.svg'])).toEqual(['src/popup/logo.svg']);
      });
      expect(disallowedSrcFiles([file])).toEqual(wasListed ? [] : [file]);
    },
  );

  // A file named after something every object inherits once passed the gate: src/popup/evil.constructor.
  it.each(PROTOTYPE_NAMES)('flags evil.%s, a prototype name used as an extension', (name) => {
    const file = `src/popup/evil.${name}`;
    expect(disallowedSrcFiles([file])).toEqual([file]);
  });

  it('names WebAssembly and the list in its explanation', () => {
    expect(SRC_FILE_RULE).toContain('ALLOWED_MEDIA');
    expect(SRC_FILE_RULE).toContain('WebAssembly');
  });
});

describe('inlineScriptsInSrcHtml', () => {
  function pages(files: Record<string, string>): {
    root: string;
    names: string[];
  } {
    const root = mkdtempSync(join(tmpdir(), 'html-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return { root, names: Object.keys(files) };
  }

  const GOOD = '<script type="module" src="./index.ts"></script>';
  const check = (html: string, name = 'src/popup/popup.html') => {
    const { root, names } = pages({ [name]: html });
    try {
      return inlineScriptsInSrcHtml(root, names);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('accepts a page whose only script is exactly <script type="module" src="./index.ts"></script>', () => {
    expect(check(`<html><body><main></main>${GOOD}</body></html>`)).toEqual([]);
    expect(
      check(`<html>\n<body>\n    ${GOOD}\n</body></html>`, 'src/welcome/welcome.html'),
    ).toEqual([]);
  });

  it('does not look at files that are not html pages of src/', () => {
    const { root, names } = pages({
      'src/other.txt': '<script>x</script>',
      'tests/a.html': '<script>x</script>',
    });
    try {
      expect(inlineScriptsInSrcHtml(root, names)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['an inline script', '<script>chrome.storage.sync.clear();</script>'],
    [
      'an inline module',
      '<script type="module">import "./x.ts"; chrome.storage.sync.clear();</script>',
    ],
    ['a script with src and a body', '<script type="module" src="./index.ts">chrome.x();</script>'],
    ['an external script', '<script src="https://cdn.example/x.js"></script>'],
    ['a protocol-relative script', '<script src="//cdn.example/x.js"></script>'],
    ['a root-absolute script', '<script type="module" src="/index.ts"></script>'],
    ['a classic script', '<script src="./index.ts"></script>'],
    ['an import map', '<script type="importmap">{}</script>'],
    ['a data: script', '<script type="module" src="data:text/javascript,1"></script>'],
    // The round-9 repro: another file of src/ named as the page script (here with a "media" extension).
    ['another file', '<script type="module" src="./evil.constructor"></script>'],
    ['another ts file', '<script type="module" src="./other.ts"></script>'],
    ['a file in another directory', '<script type="module" src="../shared/constants.ts"></script>'],
    ['crossorigin', '<script type="module" crossorigin src="./index.ts"></script>'],
    ['async', '<script type="module" src="./index.ts" async></script>'],
    ['defer', '<script type="module" src="./index.ts" defer></script>'],
    ['another type', '<script type="text/javascript" src="./index.ts"></script>'],
    ['the attributes in another order', '<script src="./index.ts" type="module"></script>'],
    ['single quotes', "<script type='module' src='./index.ts'></script>"],
    ['upper case', '<SCRIPT type="module" src="./index.ts"></SCRIPT>'],
    ['a line break in the tag', '<script\n  type="module"\n  src="./index.ts"\n></script>'],
    ['a second script', `${GOOD}${GOOD}`],
    [
      'the page script plus another',
      `${GOOD}<script type="module" src="./evil.constructor"></script>`,
    ],
    ['the page script plus an inline one', `${GOOD}<script>alert(1)</script>`],
    ['a script hidden in a comment', `${GOOD}<!-- <script src="./evil.ts"></script> -->`],
    ['no script at all', '<main></main>'],
  ])('flags %s: a page has exactly one script and it is exactly the entry point', (_name, tags) => {
    const problems = check(`<html><body>${tags}</body></html>`);
    expect(problems).toEqual([expect.stringContaining('src/popup/popup.html')]);
    expect(problems.join('\n')).toContain(GOOD);
  });
});

describe('viteConfigImports', () => {
  it('lists the files that run when Vite loads the configuration, and what they import from outside the repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viteimports-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(
        join(dir, 'vite.config.ts'),
        "import { defineConfig } from 'vite';\nimport './scripts/a';\nimport fs from 'node:fs';\nimport evil from 'some-package';\nexport default defineConfig({});\n",
      );
      writeFileSync(
        join(dir, 'scripts', 'a.ts'),
        "import { join } from 'node:path';\nimport './b';\nexport {};\n",
      );
      writeFileSync(
        join(dir, 'scripts', 'b.ts'),
        "const x = await import('left-pad');\nexport {};\n",
      );
      const closure = viteConfigImports(['vite.config.ts'], dir);
      expect(closure.files).toEqual(['scripts/a.ts', 'scripts/b.ts', 'vite.config.ts']);
      expect(closure.external).toEqual([
        'left-pad',
        'node:fs',
        'node:path',
        'some-package',
        'vite',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('filesInNodeModules', () => {
  it('flags any repository file below a node_modules directory, at any depth', () => {
    expect(
      filesInNodeModules([
        'src/popup/node_modules/evil.ts',
        'node_modules/x/index.js',
        'a/b/node_modules/c/d.ts',
        'src/node_modules_like/ok.ts',
        'src/popup/app.ts',
      ]),
    ).toEqual([
      'src/popup/node_modules/evil.ts',
      'node_modules/x/index.js',
      'a/b/node_modules/c/d.ts',
    ]);
  });
});

describe('disallowedPublicFiles', () => {
  it('allows only locale message files and icons', () => {
    expect(
      disallowedPublicFiles([
        'public/_locales/en/messages.json',
        'public/_locales/pt_BR/messages.json',
        'public/icons/icon-16.png',
        'src/popup/popup.html',
      ]),
    ).toEqual([]);
  });

  it.each([
    'public/legacy.js',
    'public/page.html',
    'public/module.mjs',
    'public/app.wasm',
    'public/_locales/en/extra.js',
    'public/icons/logo.svg',
    'public/data.json',
  ])('flags %s', (file) => {
    expect(disallowedPublicFiles([file])).toEqual([file]);
  });
});

describe('programFilesOutsideSrc', () => {
  const project = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'program-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return root;
  };
  const tsconfig = JSON.stringify({
    compilerOptions: {
      types: [],
      noEmit: true,
      module: 'esnext',
      moduleResolution: 'bundler',
      resolveJsonModule: true,
    },
    include: ['src'],
  });

  it('finds files outside src that src imports, however deep the chain', () => {
    const root = project({
      'tsconfig.json': tsconfig,
      'src/a.ts': "export { b } from './b';\nexport { c } from '../lib/c';",
      'src/b.ts': 'export const b = 1;',
      'lib/c.ts': "export { d } from '../scripts/d';",
      'scripts/d.ts': 'export const d = 1;',
    });
    try {
      expect(programFilesOutsideSrc('tsconfig.json', root)).toEqual(['lib/c.ts', 'scripts/d.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts JSON and libraries, and a program made only of src files', () => {
    const root = project({
      'tsconfig.json': tsconfig,
      'src/a.ts': "import data from '../public/data.json';\nexport const a: number = data.n;",
      'public/data.json': '{ "n": 1 }',
    });
    try {
      expect(programFilesOutsideSrc('tsconfig.json', root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('symlinksInRepo', () => {
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });

  function repo(): string {
    const root = mkdtempSync(join(tmpdir(), 'symlinks-'));
    git(root, 'init', '-q');
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'x.ts'), 'export {};');
    writeFileSync(join(root, 'src', 'plain.ts'), 'export {};');
    return root;
  }

  it('finds symbolic links to files and directories, tracked or not, imported or not', () => {
    const root = repo();
    try {
      symlinkSync(join(root, 'scripts', 'x.ts'), join(root, 'src', 'tracked.ts'));
      git(root, 'add', '.');
      symlinkSync(join(root, 'scripts'), join(root, 'src', 'dir'));
      expect(symlinksInRepo(root)).toEqual(['src/dir', 'src/tracked.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('trusts the git mode 120000 even where the work tree holds a plain file (core.symlinks=false)', () => {
    const root = repo();
    try {
      const blob = git(root, 'hash-object', '-w', '--stdin').trim();
      git(root, 'update-index', '--add', '--cacheinfo', `120000,${blob},src/link.ts`);
      writeFileSync(join(root, 'src', 'link.ts'), '../scripts/x.ts');
      expect(symlinksInRepo(root)).toEqual(['src/link.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports nothing for regular files, ignored paths and files deleted from the work tree', () => {
    const root = repo();
    try {
      git(root, 'add', '.');
      rmSync(join(root, 'src', 'plain.ts'));
      expect(symlinksInRepo(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
