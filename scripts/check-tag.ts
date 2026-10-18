import { checkTagAgainstZip } from './lib/tag';

// Usage: tsx scripts/check-tag.ts <tag> <directory with the release zip>
const [tag, dir] = process.argv.slice(2);
if (tag === undefined || dir === undefined) {
  console.error('Usage: tsx scripts/check-tag.ts <tag> <directory with the release zip>');
  process.exit(2);
}
const problems = checkTagAgainstZip(tag, dir);
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`Tag ${tag} matches the zip in ${dir}`);
