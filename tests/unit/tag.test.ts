import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTag, checkTagAgainstZip } from '../../scripts/lib/tag';
import { zipDirectory } from '../../scripts/lib/zip';

describe('checkTag', () => {
  it('accepts the tag that is v plus the version', () => {
    expect(checkTag({ tag: 'v0.1.0', version: '0.1.0' })).toEqual([]);
    expect(checkTag({ tag: 'v1.2.3.4', version: '1.2.3.4' })).toEqual([]);
  });

  it('also accepts a full ref name', () => {
    expect(checkTag({ tag: 'refs/tags/v0.1.0', version: '0.1.0' })).toEqual([]);
  });

  it.each(['v0.1.1', 'v0.1.0-rc1', '0.1.0', 'V0.1.0', 'v0.1.0 ', 'v0.1', 'release-0.1.0', ''])(
    'rejects tag %j for version 0.1.0',
    (tag) => {
      const problems = checkTag({ tag, version: '0.1.0' });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('v0.1.0');
    },
  );

  it('rejects a version Chrome would refuse even when the tag matches it', () => {
    expect(checkTag({ tag: 'v0.01.0', version: '0.01.0' }).join('\n')).toMatch(/Chrome/);
  });
});

describe('checkTagAgainstZip', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tag-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeZip(name: string, manifest: string): string {
    const source = join(root, `src-${name}`);
    mkdirSync(source);
    writeFileSync(join(source, 'manifest.json'), manifest);
    const out = join(root, `release-${name}`);
    mkdirSync(out, { recursive: true });
    zipDirectory(source, join(out, `${name}.zip`));
    return out;
  }

  it('reads the version of the manifest inside the only zip in the directory', () => {
    const dir = makeZip('ext', '{"version":"0.2.0"}');
    expect(checkTagAgainstZip('v0.2.0', dir)).toEqual([]);
    expect(checkTagAgainstZip('v0.1.0', dir).join('\n')).toContain('v0.2.0');
  });

  it('fails when there is no zip, or more than one', () => {
    mkdirSync(join(root, 'empty'));
    expect(checkTagAgainstZip('v0.1.0', join(root, 'empty')).join('\n')).toMatch(/exactly one zip/);
    const dir = makeZip('a', '{"version":"0.1.0"}');
    writeFileSync(join(dir, 'b.zip'), 'x');
    expect(checkTagAgainstZip('v0.1.0', dir).join('\n')).toMatch(/exactly one zip/);
  });

  it('fails when the zip has no readable manifest', () => {
    const noManifest = join(root, 'plain');
    mkdirSync(noManifest);
    writeFileSync(join(noManifest, 'other.txt'), 'x');
    const out = join(root, 'release-none');
    mkdirSync(out);
    zipDirectory(noManifest, join(out, 'ext.zip'));
    expect(checkTagAgainstZip('v0.1.0', out).join('\n')).toMatch(/manifest\.json/);

    const broken = makeZip('broken', 'not json');
    expect(checkTagAgainstZip('v0.1.0', broken).join('\n')).toMatch(/manifest\.json/);

    const noVersion = makeZip('noversion', '{"name":"x"}');
    expect(checkTagAgainstZip('v0.1.0', noVersion).join('\n')).toMatch(/version/);
  });
});
