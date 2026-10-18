import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRelease, releaseFileName } from '../../scripts/lib/release';

describe('releaseFileName', () => {
  it('is <name>-<version>.zip', () => {
    expect(releaseFileName('chrome-extension-template', '0.1.0')).toBe(
      'chrome-extension-template-0.1.0.zip',
    );
  });

  it('flattens a scoped package name so the zip stays directly in the release directory', () => {
    expect(releaseFileName('@acme/page-counter', '1.2.3')).toBe('acme-page-counter-1.2.3.zip');
  });
});

describe('createRelease', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'manifest.json'), '{"version":"0.2.0"}');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the zip and its checksum and returns their paths', () => {
    const { zip, checksum } = createRelease({
      distDir: join(root, 'dist'),
      outDir: join(root, 'release'),
      name: 'ext',
      version: '0.2.0',
    });
    expect(readdirSync(join(root, 'release')).sort()).toEqual([
      'ext-0.2.0.zip',
      'ext-0.2.0.zip.sha256',
    ]);
    expect(zip).toBe(join(root, 'release', 'ext-0.2.0.zip'));
    expect(checksum).toBe(`${zip}.sha256`);
  });

  it('removes zips from earlier versions so a stale one is never published', () => {
    const outDir = join(root, 'release');
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'ext-0.1.0.zip'), 'old');
    writeFileSync(join(outDir, 'ext-0.1.0.zip.sha256'), 'old');
    createRelease({
      distDir: join(root, 'dist'),
      outDir,
      name: 'ext',
      version: '0.2.0',
    });
    expect(existsSync(join(outDir, 'ext-0.1.0.zip'))).toBe(false);
    expect(readdirSync(outDir).sort()).toEqual(['ext-0.2.0.zip', 'ext-0.2.0.zip.sha256']);
  });
});
