import type { Linter } from 'eslint';

/** Typing for the JavaScript flat config, so tests can load and inspect it. */
declare const config: Linter.Config[];
export default config;
