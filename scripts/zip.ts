import { readFileSync } from 'node:fs';
import { readBundleFiles, verifyDist } from './lib/dist';
import { createRelease } from './lib/release';
import { checkVersion } from './lib/version';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };

const problems = [
  ...checkVersion({ packageVersion: pkg.version }),
  ...verifyDist('dist', {
    e2e: false,
    version: pkg.version,
    bundles: readBundleFiles(false),
  }),
];
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const { zip, checksum } = createRelease({
  distDir: 'dist',
  outDir: 'release',
  name: pkg.name,
  version: pkg.version,
});
console.log(`wrote ${zip}\nwrote ${checksum}`);
