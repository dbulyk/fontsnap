import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { writeChecksum, zipDirectory } from '../../scripts/lib/zip';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zip-'));
  mkdirSync(join(root, 'src', 'sub'), { recursive: true });
  writeFileSync(join(root, 'src', 'manifest.json'), '{"version":"1.0.0"}');
  writeFileSync(join(root, 'src', 'sub', 'a.txt'), 'hello');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('zipDirectory', () => {
  it('puts directory contents at the archive root, sorted, round-tripping the data', () => {
    const out = join(root, 'out', 'ext.zip');
    zipDirectory(join(root, 'src'), out);
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    expect(Object.keys(files)).toEqual(['manifest.json', 'sub/a.txt']);
    expect(new TextDecoder().decode(files['sub/a.txt'])).toBe('hello');
  });

  it('produces byte-identical output regardless of file timestamps', () => {
    const first = join(root, 'one.zip');
    const second = join(root, 'two.zip');
    zipDirectory(join(root, 'src'), first);
    utimesSync(join(root, 'src', 'sub', 'a.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    zipDirectory(join(root, 'src'), second);
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
  });
});

describe('writeChecksum', () => {
  it('writes a sha256sum-compatible file next to the zip', () => {
    const zip = join(root, 'out', 'ext.zip');
    zipDirectory(join(root, 'src'), zip);
    const checksumFile = writeChecksum(zip);
    const expected = createHash('sha256').update(readFileSync(zip)).digest('hex');
    expect(checksumFile).toBe(`${zip}.sha256`);
    expect(readFileSync(checksumFile, 'utf8')).toBe(`${expected}  ${basename(zip)}\n`);
  });
});
