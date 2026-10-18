import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { checkVersion } from './version';

/** A release tag must be exactly `v` + the extension version. `tag` may be a full ref name. */
export function checkTag({ tag, version }: { tag: string; version: string }): string[] {
  const problems = checkVersion({ packageVersion: version });
  const name = tag.replace(/^refs\/tags\//, '');
  if (name !== `v${version}`) {
    problems.push(`Tag "${name}" does not match the manifest version: expected "v${version}"`);
  }
  return problems;
}

/** Version declared by the manifest.json inside a zip, or a description of what is wrong. */
function readZipVersion(zipFile: string): { version: string } | { error: string } {
  const files = unzipSync(new Uint8Array(readFileSync(zipFile)), {
    filter: (file) => file.name === 'manifest.json',
  });
  const manifest = files['manifest.json'];
  if (!manifest) return { error: `${zipFile} contains no manifest.json` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    return { error: `manifest.json in ${zipFile} is not valid JSON` };
  }
  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string'
    ? { version }
    : { error: `manifest.json in ${zipFile} has no string "version"` };
}

/** Checks `tag` against the manifest of the single release zip in `dir` (what will be published). */
export function checkTagAgainstZip(tag: string, dir: string): string[] {
  const zips = readdirSync(dir).filter((name) => name.endsWith('.zip'));
  const [zip] = zips;
  if (zips.length !== 1 || zip === undefined) {
    return [`Expected exactly one zip in ${dir}, found ${String(zips.length)}`];
  }
  const result = readZipVersion(join(dir, zip));
  return 'error' in result ? [result.error] : checkTag({ tag, version: result.version });
}
