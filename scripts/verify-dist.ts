import { readFileSync } from 'node:fs';
import { readBundleFiles, verifyDist } from './lib/dist';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const e2e = process.argv.includes('--e2e');
const dir = e2e ? 'dist-e2e' : 'dist';
const problems = verifyDist(dir, { e2e, version: pkg.version, bundles: readBundleFiles(e2e) });
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`${dir} OK`);
