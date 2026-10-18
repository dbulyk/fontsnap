import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeChecksum, zipDirectory } from './zip';

/** `<name>-<version>.zip`; a scoped name (@org/name) is flattened (org-name). */
export function releaseFileName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.zip`;
}

/**
 * Zips `distDir` into `outDir` with a checksum next to it. The output directory is emptied first,
 * so a zip left over from an earlier version can never be uploaded or published by mistake.
 */
export function createRelease(options: {
  distDir: string;
  outDir: string;
  name: string;
  version: string;
}): { zip: string; checksum: string } {
  rmSync(options.outDir, { recursive: true, force: true });
  const zip = join(options.outDir, releaseFileName(options.name, options.version));
  zipDirectory(options.distDir, zip);
  return { zip, checksum: writeChecksum(zip) };
}
