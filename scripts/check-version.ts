import { existsSync, readFileSync } from 'node:fs';
import { buildManifest } from '../src/manifest';
import { checkVersion } from './lib/version';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const problems = checkVersion({
  packageVersion: pkg.version,
  manifestVersion: buildManifest({ version: pkg.version }).version,
});

// After a build, the manifest actually shipped must match as well.
if (existsSync('dist/manifest.json')) {
  const built = JSON.parse(readFileSync('dist/manifest.json', 'utf8')) as { version: string };
  problems.push(...checkVersion({ packageVersion: pkg.version, manifestVersion: built.version }));
}

const unique = [...new Set(problems)];
if (unique.length > 0) {
  console.error(unique.join('\n'));
  process.exit(1);
}
console.log(`version ${pkg.version} OK`);
