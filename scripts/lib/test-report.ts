import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Run-time proof that the test suites really ran. Lint can forbid skip/fixme/retries, but only
// the reports written by Vitest and Playwright show what happened: nothing skipped, nothing
// retried, and every spec file on disk executed.

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const normalize = (path: string) => path.split(sep).join('/');

function missingFiles(expected: readonly string[], seen: readonly string[]): string[] {
  const names = seen.map(normalize);
  return expected
    .map(normalize)
    .filter((file) => !names.some((name) => name === file || name.endsWith(`/${file}`)))
    .map((file) => `${file} is required (on disk or mandatory) but did not run`);
}

/** Checks a Vitest JSON report (`reporters: ['json']`). Returns problems, empty when clean. */
export function checkVitestReport(report: unknown, expectedFiles: readonly string[]): string[] {
  if (!isRecord(report) || !Array.isArray(report['testResults'])) {
    return ['Vitest report is missing or malformed'];
  }
  const problems: string[] = [];
  const total = report['numTotalTests'];
  if (typeof total !== 'number' || total <= 0) problems.push('Vitest ran no tests');
  for (const [counter, label] of [
    ['numFailedTests', 'failed'],
    ['numPendingTests', 'skipped/pending'],
    ['numTodoTests', 'todo'],
  ] as const) {
    if (report[counter] !== 0)
      problems.push(`Vitest reports ${String(report[counter])} ${label} test(s)`);
  }
  const seen: string[] = [];
  for (const file of records(report['testResults'])) {
    seen.push(String(file['name']));
    for (const test of records(file['assertionResults'])) {
      if (test['status'] !== 'passed') {
        problems.push(
          `${String(file['name'])}: "${String(test['title'])}" is ${String(test['status'])}`,
        );
      }
    }
  }
  return [...problems, ...missingFiles(expectedFiles, seen)];
}

const FORBIDDEN_ANNOTATIONS = new Set(['skip', 'fixme', 'fail']);

function collectPlaywright(suites: unknown, seenFiles: string[], problems: string[]): void {
  for (const suite of records(suites)) {
    if (typeof suite['file'] === 'string') seenFiles.push(suite['file']);
    for (const spec of records(suite['specs'])) {
      for (const test of records(spec['tests'])) {
        const name = `${String(spec['file'] ?? suite['file'])}: ${String(spec['title'])}`;
        if (test['expectedStatus'] !== 'passed' || test['status'] !== 'expected') {
          problems.push(
            `${name}: expected ${String(test['expectedStatus'])}, got ${String(test['status'])}`,
          );
        }
        for (const annotation of records(test['annotations'])) {
          if (FORBIDDEN_ANNOTATIONS.has(String(annotation['type']))) {
            problems.push(`${name}: annotated ${String(annotation['type'])}`);
          }
        }
        for (const result of records(test['results'])) {
          if (result['retry'] !== 0)
            problems.push(`${name}: ran with a retry (${String(result['retry'])})`);
        }
      }
    }
    collectPlaywright(suite['suites'], seenFiles, problems);
  }
}

/** Checks a Playwright JSON report. `expectedFiles` are spec paths relative to the test directory. */
export function checkPlaywrightReport(report: unknown, expectedFiles: readonly string[]): string[] {
  if (!isRecord(report) || !isRecord(report['stats']) || !Array.isArray(report['suites'])) {
    return ['Playwright report is missing or malformed'];
  }
  const problems: string[] = [];
  const stats = report['stats'];
  if (typeof stats['expected'] !== 'number' || stats['expected'] <= 0)
    problems.push('Playwright ran no tests');
  for (const key of ['skipped', 'unexpected', 'flaky'] as const) {
    if (stats[key] !== 0) problems.push(`Playwright reports ${String(stats[key])} ${key} test(s)`);
  }
  if (Array.isArray(report['errors']) && report['errors'].length > 0) {
    problems.push(`Playwright reported ${String(report['errors'].length)} error(s)`);
  }
  const projects = isRecord(report['config']) ? records(report['config']['projects']) : [];
  for (const project of projects) {
    if (project['retries'] !== 0) {
      problems.push(
        `Playwright project "${String(project['name'])}" has retries: ${String(project['retries'])}`,
      );
    }
  }
  const seen: string[] = [];
  collectPlaywright(report['suites'], seen, problems);
  return [...problems, ...missingFiles(expectedFiles, seen)];
}

/** Spec files below `dir` whose name ends with `suffix`, as paths relative to `root`. */
export function listSpecFiles(root: string, dir: string, suffix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSpecFiles(root, path, suffix);
    return entry.name.endsWith(suffix) ? [normalize(relative(root, path))] : [];
  });
}

/** Checks `reports/vitest-guard.json` written by GuardReporter against the number of tests Vitest ran. */
export function checkVitestGuardReport(report: unknown, totalTests: number): string[] {
  if (
    !isRecord(report) ||
    typeof report['tests'] !== 'number' ||
    !Array.isArray(report['violations'])
  ) {
    return ['reports/vitest-guard.json is missing or malformed (is GuardReporter registered?)'];
  }
  const problems = report['violations'].map(
    (violation) => `Vitest guard reporter: ${String(violation)}`,
  );
  if (report['tests'] !== totalTests) {
    problems.push(
      `Vitest guard reporter saw ${String(report['tests'])} tests, Vitest ran ${String(totalTests)}`,
    );
  }
  return problems;
}

/**
 * Guard tests that must always run, whatever happens to the files: deleting, renaming or excluding
 * one of them is a failure, not a quiet way to switch a guard off.
 */
export const MANDATORY_UNIT_TESTS = [
  'tests/unit/guards.test.ts',
  'tests/unit/guards-lib.test.ts',
  'tests/unit/source-scan.test.ts',
  'tests/unit/src-types.test.ts',
  'tests/unit/eslint-rules.test.ts',
  'tests/unit/layout.test.ts',
  'tests/unit/prettier-guard.test.ts',
  'tests/unit/guard-reporter.test.ts',
  'tests/unit/test-report.test.ts',
  'tests/unit/dist.test.ts',
  'tests/unit/workflow-lint.test.ts',
];
export const MANDATORY_E2E_SPECS = ['sender-policy.spec.ts'];

/** Files in tests/unit (relative to it) that Vitest would not run: only *.test.ts and helpers/ belong there. */
export function strayUnitFiles(files: readonly string[]): string[] {
  return files.filter((file) => !file.endsWith('.test.ts') && !file.startsWith('helpers/'));
}

/** Files in tests/e2e (relative to it) that Playwright would not run and that are not the shared modules or support/. */
export function strayE2eFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      !file.endsWith('.spec.ts') &&
      file !== 'fixtures.ts' &&
      file !== 'site-data.ts' &&
      !file.startsWith('support/'),
  );
}
