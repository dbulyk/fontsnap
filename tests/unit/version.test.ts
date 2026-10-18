import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/manifest';
import { checkVersion } from '../../scripts/lib/version';

describe('checkVersion', () => {
  it('accepts matching x.y.z versions', () => {
    expect(checkVersion({ packageVersion: '0.1.0', manifestVersion: '0.1.0' })).toEqual([]);
    expect(checkVersion({ packageVersion: '0.1.0' })).toEqual([]);
  });

  // Chrome: one to four dot-separated integers, each 0-65535, no leading zeros.
  it.each(['0', '1', '1.0', '0.1.0', '10.20.30', '1.2.3.4', '65535.65535.65535.65535', '0.0.1'])(
    'accepts %j',
    (version) => {
      expect(checkVersion({ packageVersion: version })).toEqual([]);
    },
  );

  it.each([
    '',
    '0.01.0',
    '01.0.0',
    '1.00',
    '0.1.70000',
    '65536',
    '1.0.0.0.0',
    '1..0',
    '1.0.',
    '.1',
    'v1.0.0',
    '1.0.0-beta',
    '1.0.0+build',
    '-1.0',
    '1.0 ',
    '1.a.0',
    '1e3',
  ])('rejects %j as not a Chrome version', (version) => {
    expect(checkVersion({ packageVersion: version }).join('\n')).toMatch(/Chrome/);
  });

  it('reports a mismatch between package.json and the manifest', () => {
    const problems = checkVersion({
      packageVersion: '0.1.0',
      manifestVersion: '0.2.0',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/0\.1\.0.*0\.2\.0/);
  });
});

describe('single version source', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    version: string;
  };

  it('package.json has a valid version and the generated manifest carries it', () => {
    const manifest = buildManifest({ version: pkg.version });
    expect(
      checkVersion({
        packageVersion: pkg.version,
        manifestVersion: manifest.version,
      }),
    ).toEqual([]);
  });
});
