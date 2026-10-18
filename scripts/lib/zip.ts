import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { zipSync, type Zippable } from 'fflate';

function collect(root: string, dir: string, into: Zippable): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      collect(root, path, into);
    } else {
      // A fixed timestamp keeps the archive reproducible: same input, same bytes.
      into[relative(root, path).split(sep).join('/')] = [
        new Uint8Array(readFileSync(path)),
        { mtime: new Date(1980, 0, 1), level: 9 },
      ];
    }
  }
}

/** Zips the contents of `dir` (manifest.json at the archive root) into `outFile`. */
export function zipDirectory(dir: string, outFile: string): void {
  const entries: Zippable = {};
  collect(dir, dir, entries);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, zipSync(entries));
}

/** Writes `<zip>.sha256` in `sha256sum` format (so `sha256sum -c` verifies it) and returns its path. */
export function writeChecksum(zipFile: string): string {
  const digest = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
  const checksumFile = `${zipFile}.sha256`;
  writeFileSync(checksumFile, `${digest}  ${basename(zipFile)}\n`);
  return checksumFile;
}
