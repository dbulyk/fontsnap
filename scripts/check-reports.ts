import { readFileSync } from 'node:fs';
import {
  checkPlaywrightReport,
  checkVitestGuardReport,
  checkVitestReport,
  listSpecFiles,
  MANDATORY_E2E_SPECS,
  MANDATORY_UNIT_TESTS,
  strayE2eFiles,
  strayUnitFiles,
} from './lib/test-report';

// Usage: tsx scripts/check-reports.ts vitest|playwright
const kind = process.argv[2];
const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

let problems: string[];
if (kind === 'vitest') {
  const report = read('reports/vitest.json');
  const total = (report as { numTotalTests?: number } | undefined)?.numTotalTests ?? 0;
  problems = [
    ...checkVitestReport(report, [
      ...new Set([...listSpecFiles('.', 'tests/unit', '.test.ts'), ...MANDATORY_UNIT_TESTS]),
    ]),
    ...strayUnitFiles(listSpecFiles('tests/unit', 'tests/unit', '')).map(
      (file) => `tests/unit/${file} is not run by Vitest (only *.test.ts and helpers/ belong here)`,
    ),
    ...checkVitestGuardReport(read('reports/vitest-guard.json'), total),
  ];
} else if (kind === 'playwright') {
  problems = [
    ...checkPlaywrightReport(read('reports/playwright.json'), [
      ...new Set([...listSpecFiles('tests/e2e', 'tests/e2e', '.spec.ts'), ...MANDATORY_E2E_SPECS]),
    ]),
    ...strayE2eFiles(listSpecFiles('tests/e2e', 'tests/e2e', '')).map(
      (file) =>
        `tests/e2e/${file} is not run by Playwright (only *.spec.ts and the shared modules belong here)`,
    ),
  ];
} else {
  console.error('Usage: tsx scripts/check-reports.ts vitest|playwright');
  process.exit(2);
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`${kind} report OK`);
