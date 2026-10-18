import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';

/** The part of Vitest's TestCase this reporter reads (kept narrow so tests can fake it). */
interface Inspectable {
  fullName: string;
  options: {
    mode?: string;
    fails?: boolean | undefined;
    retry?: unknown;
    repeats?: number | undefined;
  };
  diagnostic(): { retryCount: number; flaky?: boolean } | undefined;
}

function retryCount(retry: unknown): number {
  if (typeof retry === 'number') return retry;
  const count = (retry as { count?: unknown } | undefined)?.count;
  return typeof count === 'number' ? count : 0;
}

/**
 * What a test may not carry, whatever syntax put it there: retry, expected-fail, repeats, a mode
 * other than "run" (skip, todo, only), or an executed retry. Lint cannot see options objects or
 * `.extend()` chains; Vitest's own data can.
 */
export function findTestViolations(test: Inspectable): string[] {
  const { options } = test;
  const problems: string[] = [];
  if (retryCount(options.retry) > 0) problems.push('uses retry');
  if (options.fails === true) problems.push('is expected to fail (fails)');
  if ((options.repeats ?? 0) > 0) problems.push('uses repeats');
  if (options.mode !== undefined && options.mode !== 'run')
    problems.push(`has mode "${options.mode}"`);
  const diagnostic = test.diagnostic();
  if ((diagnostic?.retryCount ?? 0) > 0 || diagnostic?.flaky === true)
    problems.push('was retried or is flaky');
  return problems.map((problem) => `${test.fullName} ${problem}`);
}

export interface GuardReporterOptions {
  outputFile?: string;
  setExitCode?: (code: number) => void;
  log?: (message: string) => void;
}

/**
 * Fails the Vitest run on any test found by `findTestViolations` and writes how many tests it saw
 * to `reports/vitest-guard.json`; scripts/check-reports.ts requires that file, so removing this
 * reporter from the config is noticed too.
 */
export class GuardReporter implements Reporter {
  private readonly violations: string[] = [];
  private tests = 0;
  private readonly outputFile: string;
  private readonly setExitCode: (code: number) => void;
  private readonly log: (message: string) => void;

  constructor(options: GuardReporterOptions = {}) {
    this.outputFile = options.outputFile ?? 'reports/vitest-guard.json';
    this.setExitCode =
      options.setExitCode ??
      ((code) => {
        process.exitCode = code;
      });
    this.log =
      options.log ??
      ((message) => {
        console.error(message);
      });
  }

  onTestCaseResult(testCase: TestCase): void {
    this.tests += 1;
    this.violations.push(...findTestViolations(testCase));
  }

  onTestRunEnd(): void {
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(
      this.outputFile,
      JSON.stringify({ tests: this.tests, violations: this.violations }, null, 2),
    );
    if (this.violations.length > 0) {
      for (const violation of this.violations) this.log(`guard-reporter: ${violation}`);
      this.setExitCode(1);
    }
  }
}

// Vitest loads a reporter given by path through its default export.
export default GuardReporter;
