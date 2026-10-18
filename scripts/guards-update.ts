import { writeGuards } from './lib/guards';

// Regenerates tests/guard-snapshots/*.json from the current configuration. Review
// `git diff tests/guard-snapshots` and explain every change in the pull request.
const written = await writeGuards();
console.log(`${written.join('\n')}\nReview: git diff tests/guard-snapshots`);
