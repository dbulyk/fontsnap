import type { Linter, Rule } from 'eslint';

/** Typing for the JavaScript flat config, so tests can load and inspect it. */
declare const config: Linter.Config[];
export default config;

/** The local rule that holds src/ to the allowlist of globals (GLOBAL_ACCESS in eslint.config.js). */
export declare const globalAccessRule: Rule.RuleModule;
export declare const fontsnapPlugin: { rules: { 'global-access': Rule.RuleModule } };
