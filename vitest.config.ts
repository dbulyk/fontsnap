import { defineConfig } from 'vitest/config';

const threshold = { statements: 80, branches: 80, functions: 80, lines: 80 };

export default defineConfig({
  // Inline PostCSS options switch off the search for postcss.config.* / .postcssrc*, so such a
  // file cannot run Node code while the unit tests load (the guards forbid the names as well).
  css: { postcss: {} },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Typed ESLint and TypeScript program tests are slow on a cold start.
    testTimeout: 30_000,
    // With CI=true typescript-eslint infers "single run" mode and lints the files on disk,
    // ignoring the code passed to ESLint#lintText, so lint fixtures would pass vacuously on CI.
    env: { TSESTREE_SINGLE_RUN: 'false' },
    // The JSON report is checked by scripts/check-reports.ts: nothing skipped, every file ran.
    // GuardReporter fails the run for retry/fails/repeats/skip/todo given as test options.
    reporters: ['default', 'json', './scripts/lib/guard-reporter.ts'],
    outputFile: { json: 'reports/vitest.json' },
    coverage: {
      provider: 'v8',
      // Product code and the build/check logic that guards it.
      include: ['src/**/*.ts', 'scripts/lib/**/*.ts'],
      // Entry points are covered too (tests/unit/entrypoints.test.ts); only declarations are left out.
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        ...threshold,
        'src/shared/**': threshold,
        'scripts/lib/**': threshold,
      },
    },
  },
});
