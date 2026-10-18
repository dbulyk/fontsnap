import { defineConfig } from '@playwright/test';

export function createConfig(ci: boolean) {
  return defineConfig({
    testDir: 'tests/e2e',
    // Tests are independent: each gets its own browser profile, and each worker its own server.
    fullyParallel: true,
    workers: ci ? 2 : 3,
    // No retries: a flaky test must be fixed, not hidden.
    retries: 0,
    forbidOnly: ci,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    // The JSON report is checked by scripts/check-reports.ts: nothing skipped or retried, every spec ran.
    reporter: [
      ['list'],
      ['json', { outputFile: 'reports/playwright.json' }],
      ...(ci ? ([['html', { open: 'never' }]] as const) : []),
    ],
    use: { trace: 'retain-on-failure' },
  });
}

const ci = process.env['CI'] !== undefined && process.env['CI'] !== '';
export default createConfig(ci);
