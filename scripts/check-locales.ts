import { checkLocales, CWS_LOCALES } from './lib/locales';

const problems = checkLocales({
  localesDir: 'public/_locales',
  srcDir: 'src',
  requiredLocales: CWS_LOCALES,
  brand: 'FontSnap',
});
for (const problem of problems) console.error(`[${problem.rule}] ${problem.message}`);
if (problems.length > 0) {
  console.error(`\n${String(problems.length)} locale problem(s)`);
  process.exit(1);
}
console.log('locales OK');
