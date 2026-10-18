import { describe, expect, it } from 'vitest';
import {
  isRegistrySpec,
  lockfileProblems,
  nonRegistrySpecifiers,
} from '../../scripts/lib/packages';
import { PROTOTYPE_NAMES } from './helpers/media';

describe('isRegistrySpec', () => {
  it.each([
    '^1.2.3',
    '~1.2.3',
    '1.2.3',
    '1.2',
    '1',
    '>=1.2.3 <2',
    '>1.0.0',
    '<=2.0.0-beta.1',
    '1.x',
    '1.2.x',
    '*',
    'x',
    '',
    '^1.2.3 || ^2.0.0',
    '1.2.3 - 2.3.4',
    'v1.2.3',
    '1.2.3-rc.1+build.5',
    'latest',
    'next',
    'beta',
    'canary-2024',
    '$nanoid',
  ])('accepts the registry specifier %j', (spec) => {
    expect(isRegistrySpec(spec)).toBe(true);
  });

  it.each([
    'file:vendor/x.tgz',
    'file:../x',
    'link:../x',
    'git+https://github.com/a/b.git',
    'git+ssh://git@github.com/a/b.git',
    'git://github.com/a/b.git',
    'github:a/b',
    'a/b',
    'a/b#semver:^1.0.0',
    'https://example.com/x.tgz',
    'http://example.com/x.tgz',
    'npm:other@^1.0.0',
    'workspace:*',
    './vendor/x.tgz',
    '../x',
    '/abs/x.tgz',
    'vendor/x.tgz',
    'x.tgz',
    'x.tar.gz',
    'x.zip',
    '~/x',
    'portal:../x',
    'patch:x@1.0.0#./p.patch',
    'jsr:@a/b@1',
    '^1.2.3 file:x',
  ])('refuses %j: not a version or a dist-tag of the npm registry', (spec) => {
    expect(isRegistrySpec(spec)).toBe(false);
  });
});

describe('nonRegistrySpecifiers', () => {
  const pkg = {
    dependencies: { nanoid: '^5.0.0' },
    devDependencies: { vite: '^8.3.4', tool: 'latest' },
    overrides: { foo: '1.2.3', bar: { baz: '$nanoid', '.': '2.0.0' } },
  };

  it('accepts dependencies, devDependencies and overrides that name registry versions or tags', () => {
    expect(nonRegistrySpecifiers(pkg)).toEqual([]);
  });

  it.each([
    ['dependencies', { dependencies: { x: 'file:vendor/x.tgz' } }, 'dependencies.x'],
    ['devDependencies', { devDependencies: { x: 'link:../x' } }, 'devDependencies.x'],
    [
      'devDependencies',
      { devDependencies: { x: 'git+https://github.com/a/x.git' } },
      'devDependencies.x',
    ],
    ['dependencies', { dependencies: { x: 'github:a/x' } }, 'dependencies.x'],
    ['dependencies', { dependencies: { x: 'a/x' } }, 'dependencies.x'],
    ['dependencies', { dependencies: { x: 'https://example.com/x.tgz' } }, 'dependencies.x'],
    ['dependencies', { dependencies: { x: 'npm:y@1' } }, 'dependencies.x'],
    ['dependencies', { dependencies: { x: 'workspace:*' } }, 'dependencies.x'],
    ['dependencies', { dependencies: { x: './vendor/x.tgz' } }, 'dependencies.x'],
    ['overrides', { overrides: { x: 'file:vendor/x.tgz' } }, 'overrides.x'],
    ['overrides (nested)', { overrides: { a: { b: { c: 'npm:evil@1' } } } }, 'overrides.a.b.c'],
    ['a value that is not a string', { dependencies: { x: 1 } }, 'dependencies.x'],
  ])('refuses a non-registry specifier in %s', (_name, extra, path) => {
    const found = nonRegistrySpecifiers({ ...pkg, ...extra });
    expect(found.map((problem) => problem.split(':')[0])).toContain(path);
  });

  it.each(PROTOTYPE_NAMES)('treats a dependency named %s like any other', (name) => {
    const bad = JSON.parse(`{"dependencies":{"${name}":"file:x.tgz"}}`) as Record<string, unknown>;
    const good = JSON.parse(`{"dependencies":{"${name}":"^1.0.0"}}`) as Record<string, unknown>;
    expect(nonRegistrySpecifiers(bad).join('\n')).toContain(`dependencies.${name}`);
    expect(nonRegistrySpecifiers(good)).toEqual([]);
  });

  it('ignores sections that are absent', () => {
    expect(nonRegistrySpecifiers({})).toEqual([]);
  });
});

describe('lockfileProblems', () => {
  const registry = 'https://registry.npmjs.org/';
  const lock = (packages: Record<string, unknown>) => ({
    lockfileVersion: 3,
    packages,
  });
  const good = {
    '': { name: 'x', dependencies: { nanoid: '^5.0.0' } },
    'node_modules/nanoid': {
      version: '5.0.0',
      resolved: `${registry}nanoid/-/nanoid-5.0.0.tgz`,
      integrity: 'sha512-x',
    },
  };

  it('accepts a lockfile whose packages all come from the npm registry', () => {
    expect(lockfileProblems(lock(good))).toEqual([]);
  });

  it.each([
    ['a tarball path', { resolved: 'file:vendor/x-1.0.0.tgz' }],
    ['a git url', { resolved: 'git+ssh://git@github.com/a/x.git#abc' }],
    ['another registry', { resolved: 'https://registry.example.com/x/-/x-1.0.0.tgz' }],
    ['a look-alike host', { resolved: 'https://registry.npmjs.org.evil.example/x/-/x-1.0.0.tgz' }],
    ['http', { resolved: 'http://registry.npmjs.org/x/-/x-1.0.0.tgz' }],
    ['a missing resolved', {}],
    ['a link', { resolved: 'vendor/x', link: true }],
    ['a resolved that is not a string', { resolved: 1 }],
  ])('flags %s', (_name, entry) => {
    const problems = lockfileProblems(
      lock({ ...good, 'node_modules/x': { version: '1.0.0', ...entry } }),
    );
    expect(problems).toEqual([expect.stringContaining('node_modules/x')]);
  });

  it('flags a root entry that names a non-registry dependency (the lockfile repeats package.json)', () => {
    const problems = lockfileProblems(
      lock({ ...good, '': { dependencies: { x: 'file:vendor/x.tgz' } } }),
    );
    expect(problems.join('\n')).toContain('dependencies.x');
  });

  it('flags a lockfile without packages, and one that is not an object', () => {
    expect(lockfileProblems({})).toEqual([expect.stringContaining('packages')]);
    expect(lockfileProblems(null)).toEqual([expect.stringContaining('packages')]);
  });

  it.each(PROTOTYPE_NAMES)('reads a package path %s as a plain key', (name) => {
    const packages = JSON.parse(
      `{"node_modules/${name}":{"resolved":"file:x.tgz"},"${name}":{"resolved":"file:y.tgz"}}`,
    ) as Record<string, unknown>;
    expect(lockfileProblems(lock(packages)).length).toBe(2);
  });
});
