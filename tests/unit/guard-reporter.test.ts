import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkVitestGuardReport } from '../../scripts/lib/test-report';
import { findTestViolations, GuardReporter } from '../../scripts/lib/guard-reporter';

interface Fake {
  fullName?: string;
  options?: {
    mode?: string;
    fails?: boolean;
    retry?: unknown;
    repeats?: number;
  };
  diagnostic?: { retryCount: number; flaky?: boolean } | undefined;
}

/** The slice of Vitest's TestCase that the reporter reads. */
function testCase({ fullName = 'suite > test', options = {}, diagnostic }: Fake = {}) {
  return {
    fullName,
    options: {
      mode: 'run',
      fails: undefined,
      retry: undefined,
      repeats: undefined,
      ...options,
    },
    diagnostic: () => diagnostic ?? { retryCount: 0, flaky: false },
  };
}

describe('findTestViolations', () => {
  it('accepts an ordinary test', () => {
    expect(findTestViolations(testCase())).toEqual([]);
  });

  it.each([
    ['retry: 3', { retry: 3 }],
    ['a retry object', { retry: { count: 2, delay: 10 } }],
    ['fails: true', { fails: true }],
    ['repeats: 2', { repeats: 2 }],
    ['skip', { mode: 'skip' }],
    ['todo', { mode: 'todo' }],
    ['only', { mode: 'only' }],
  ])('flags %s given as a test option', (_name, options) => {
    expect(findTestViolations(testCase({ options }))).not.toEqual([]);
  });

  it('allows retry: 0 and fails: false (they change nothing)', () => {
    expect(
      findTestViolations(testCase({ options: { retry: 0, fails: false, repeats: 0 } })),
    ).toEqual([]);
  });

  it('flags a test that actually ran again, and a flaky one', () => {
    expect(findTestViolations(testCase({ diagnostic: { retryCount: 1 } }))).not.toEqual([]);
    expect(
      findTestViolations(testCase({ diagnostic: { retryCount: 0, flaky: true } })),
    ).not.toEqual([]);
  });

  it('names the test in every message', () => {
    const [message] = findTestViolations(testCase({ fullName: 'a > b', options: { fails: true } }));
    expect(message).toContain('a > b');
  });

  it('copes with a test that has no diagnostic (it never ran)', () => {
    const neverRan = { ...testCase(), diagnostic: () => undefined };
    expect(findTestViolations(neverRan)).toEqual([]);
  });
});

describe('GuardReporter', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'guard-reporter-'));
    file = join(dir, 'reports', 'vitest-guard.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (cases: ReturnType<typeof testCase>[]) => {
    const exit = vi.fn();
    const reporter = new GuardReporter({
      outputFile: file,
      setExitCode: exit,
      log: () => undefined,
    });
    for (const item of cases) reporter.onTestCaseResult(item as never);
    reporter.onTestRunEnd();
    return { exit, report: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  };

  it('writes the number of tests seen and no violations for a clean run', () => {
    const { exit, report } = run([testCase(), testCase({ fullName: 'other' })]);
    expect(report).toEqual({ tests: 2, violations: [] });
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails the run and records every violation', () => {
    const { exit, report } = run([
      testCase(),
      testCase({ fullName: 'bad', options: { retry: 3 } }),
    ]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(report).toMatchObject({
      tests: 2,
      violations: [expect.stringContaining('bad') as unknown],
    });
  });
});

describe('checkVitestGuardReport', () => {
  it('accepts a report that saw every test and found nothing', () => {
    expect(checkVitestGuardReport({ tests: 5, violations: [] }, 5)).toEqual([]);
  });

  it.each([
    ['a violation', { tests: 5, violations: ['x: retry'] }],
    ['fewer tests seen than ran', { tests: 4, violations: [] }],
    ['a malformed report', { nope: true }],
    ['no report (the reporter was removed)', undefined],
  ])('rejects %s', (_name, report) => {
    expect(checkVitestGuardReport(report, 5)).not.toEqual([]);
  });
});

describe('GuardReporter defaults', () => {
  it('logs to the console and sets process.exitCode when nothing else is injected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-reporter-default-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = process.exitCode;
    try {
      const reporter = new GuardReporter({ outputFile: join(dir, 'out.json') });
      reporter.onTestCaseResult(testCase({ fullName: 'bad', options: { fails: true } }) as never);
      reporter.onTestRunEnd();
      expect(process.exitCode).toBe(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('guard-reporter: bad'));
    } finally {
      process.exitCode = before;
      errors.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to reports/vitest-guard.json by default', () => {
    expect(new GuardReporter()).toBeInstanceOf(GuardReporter);
  });
});
