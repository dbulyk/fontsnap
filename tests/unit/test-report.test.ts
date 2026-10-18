import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkPlaywrightReport,
  checkVitestReport,
  MANDATORY_E2E_SPECS,
  listSpecFiles,
  MANDATORY_UNIT_TESTS,
  strayE2eFiles,
  strayUnitFiles,
} from '../../scripts/lib/test-report';

type Status = 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';

function vitestReport(files: Record<string, Status[]>, overrides: Record<string, unknown> = {}) {
  const all = Object.values(files).flat();
  const count = (status: Status) => all.filter((s) => s === status).length;
  return {
    numTotalTests: all.length,
    numPassedTests: count('passed'),
    numFailedTests: count('failed'),
    numPendingTests: count('pending') + count('skipped'),
    numTodoTests: count('todo'),
    success: count('failed') === 0,
    testResults: Object.entries(files).map(([name, statuses]) => ({
      name: `/repo/${name}`,
      assertionResults: statuses.map((status, index) => ({
        title: `t${String(index)}`,
        status,
      })),
    })),
    ...overrides,
  };
}

describe('checkVitestReport', () => {
  const files = ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'];
  const good = () =>
    vitestReport({
      [files[0] ?? '']: ['passed'],
      [files[1] ?? '']: ['passed', 'passed'],
    });

  it('accepts a report where everything passed and every file ran', () => {
    expect(checkVitestReport(good(), files)).toEqual([]);
  });

  it.each([
    ['skipped', 'skipped'],
    ['pending', 'pending'],
    ['todo', 'todo'],
    ['failed', 'failed'],
  ] as const)('rejects a %s test', (_name, status) => {
    const report = vitestReport({
      'tests/unit/a.test.ts': ['passed', status],
      'tests/unit/b.test.ts': ['passed'],
    });
    expect(checkVitestReport(report, files)).not.toEqual([]);
  });

  it('rejects a spec file that is on disk but absent from the report', () => {
    const report = vitestReport({ 'tests/unit/a.test.ts': ['passed'] });
    expect(checkVitestReport(report, files).join('\n')).toContain('tests/unit/b.test.ts');
  });

  it('rejects an empty run and a malformed report', () => {
    expect(checkVitestReport(vitestReport({}), [])).not.toEqual([]);
    expect(checkVitestReport(null, files)).not.toEqual([]);
    expect(checkVitestReport({ testResults: 'x' }, files)).not.toEqual([]);
  });

  it('trusts the counters too, not only the per-test statuses', () => {
    expect(checkVitestReport({ ...good(), numPendingTests: 1 }, files)).not.toEqual([]);
    expect(checkVitestReport({ ...good(), numTodoTests: 1 }, files)).not.toEqual([]);
  });
});

interface PwResult {
  retry?: number;
  status?: string;
}
interface PwTest {
  expectedStatus?: string;
  status?: string;
  annotations?: { type: string }[];
  results?: PwResult[];
}

function playwrightReport(
  files: Record<string, PwTest[]>,
  extra: {
    stats?: Record<string, number>;
    projects?: { retries: number }[];
    errors?: unknown[];
  } = {},
) {
  const tests = Object.values(files).flat();
  return {
    config: { projects: extra.projects ?? [{ retries: 0 }] },
    errors: extra.errors ?? [],
    stats: {
      expected: tests.length,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
      ...extra.stats,
    },
    suites: Object.entries(files).map(([file, fileTests]) => ({
      title: file,
      file,
      suites: [
        {
          title: 'group',
          file,
          specs: fileTests.map((test, index) => ({
            title: `spec ${String(index)}`,
            tests: [
              {
                expectedStatus: 'passed',
                status: 'expected',
                annotations: [],
                results: [{ retry: 0, status: 'passed' }],
                ...test,
              },
            ],
          })),
        },
      ],
    })),
  };
}

describe('checkPlaywrightReport', () => {
  const files = ['a.spec.ts', 'b.spec.ts'];
  const good = () => playwrightReport({ 'a.spec.ts': [{}], 'b.spec.ts': [{}, {}] });

  it('accepts a clean report in which every spec file ran', () => {
    expect(checkPlaywrightReport(good(), files)).toEqual([]);
  });

  it.each([
    ['a skipped test', { stats: { skipped: 1 } }],
    ['an unexpected failure', { stats: { unexpected: 1 } }],
    ['a flaky test', { stats: { flaky: 1 } }],
    ['no tests', { stats: { expected: 0 } }],
    ['a project with retries', { projects: [{ retries: 2 }] }],
    ['report-level errors', { errors: [{ message: 'boom' }] }],
  ])('rejects %s', (_name, extra) => {
    const report = playwrightReport({ 'a.spec.ts': [{}], 'b.spec.ts': [{}] }, extra);
    expect(checkPlaywrightReport(report, files)).not.toEqual([]);
  });

  it.each([
    ['skip', [{ type: 'skip' }]],
    ['fixme', [{ type: 'fixme' }]],
    ['fail', [{ type: 'fail' }]],
  ])('rejects a test annotated %s', (_name, annotations) => {
    const report = playwrightReport({
      'a.spec.ts': [{ annotations }],
      'b.spec.ts': [{}],
    });
    expect(checkPlaywrightReport(report, files)).not.toEqual([]);
  });

  it('rejects a test that only passed after a retry or that expects to fail', () => {
    const retried = playwrightReport({
      'a.spec.ts': [
        {
          results: [
            { retry: 0, status: 'failed' },
            { retry: 1, status: 'passed' },
          ],
        },
      ],
      'b.spec.ts': [{}],
    });
    expect(checkPlaywrightReport(retried, files).join('\n')).toMatch(/retr/);
    const expectedFail = playwrightReport({
      'a.spec.ts': [{ expectedStatus: 'failed' }],
      'b.spec.ts': [{}],
    });
    expect(checkPlaywrightReport(expectedFail, files)).not.toEqual([]);
  });

  it('rejects a spec file on disk that did not run, and a malformed report', () => {
    const report = playwrightReport({ 'a.spec.ts': [{}] });
    expect(checkPlaywrightReport(report, files).join('\n')).toContain('b.spec.ts');
    expect(checkPlaywrightReport(undefined, files)).not.toEqual([]);
  });
});

describe('mandatory tests and stray files', () => {
  it('lists the guard tests that must always run, by path', () => {
    expect(MANDATORY_UNIT_TESTS).toEqual(
      expect.arrayContaining([
        'tests/unit/guards.test.ts',
        'tests/unit/source-scan.test.ts',
        'tests/unit/src-types.test.ts',
        'tests/unit/eslint-rules.test.ts',
      ]),
    );
    expect(MANDATORY_E2E_SPECS).toEqual(['sender-policy.spec.ts']);
  });

  it('a mandatory test missing from the report is reported even if the file was deleted', () => {
    const report = vitestReport({ 'tests/unit/other.test.ts': ['passed'] });
    const expected = ['tests/unit/other.test.ts', ...MANDATORY_UNIT_TESTS];
    const problems = checkVitestReport(report, expected).join('\n');
    expect(problems).toContain('tests/unit/guards.test.ts');
  });

  it.each([
    ['a spec renamed to .spec.ts', 'guards.spec.ts'],
    ['a file with another extension', 'guards.test.ts.bak'],
    ['a test renamed away from the pattern', 'guards.tests.ts'],
    ['a stray script', 'run.mjs'],
    ['a helper outside helpers/', 'support/x.ts'],
  ])('rejects %s in tests/unit', (_name, file) => {
    expect(strayUnitFiles([file])).toEqual([file]);
  });

  it('allows *.test.ts anywhere and anything under helpers/', () => {
    expect(
      strayUnitFiles(['guards.test.ts', 'helpers/chrome-stub.ts', 'helpers/deep/x.ts']),
    ).toEqual([]);
  });

  it.each(['popup.spec.ts.bak', 'popup.e2e.ts', 'extra.ts', 'helpers/x.ts'])(
    'rejects %s in tests/e2e',
    (file) => {
      expect(strayE2eFiles([file])).toEqual([file]);
    },
  );

  it('allows e2e specs, the fixtures and data modules, and anything under support/', () => {
    expect(
      strayE2eFiles([
        'popup.spec.ts',
        'fixtures.ts',
        'site-data.ts',
        'support/page.ts',
        'support/deep/x.ts',
      ]),
    ).toEqual([]);
  });
});

describe('listSpecFiles', () => {
  it('lists matching files in nested directories, relative to the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'spec-files-'));
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      for (const name of [
        'one.test.ts',
        'a/two.test.ts',
        'a/b/three.test.ts',
        'a/b/skip.ts',
        'a/readme.md',
      ]) {
        writeFileSync(join(root, name), '');
      }
      expect(listSpecFiles(root, root, '.test.ts').sort()).toEqual([
        'a/b/three.test.ts',
        'a/two.test.ts',
        'one.test.ts',
      ]);
      expect(listSpecFiles(root, join(root, 'a'), '')).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
