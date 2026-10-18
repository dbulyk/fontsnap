import { spawnSync } from 'node:child_process';
import { chooseE2eCommand } from './lib/e2e-command';

// xvfb-run exists when spawning it does not fail with ENOENT.
const hasXvfbRun = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error === undefined;
const choice = chooseE2eCommand({ platform: process.platform, env: process.env, hasXvfbRun });
console.log(`e2e: npm run ${choice.script} (${choice.reason})`);

const result = spawnSync('npm', ['run', choice.script], {
  stdio: 'inherit',
  env: { ...process.env, ...choice.env },
  shell: process.platform === 'win32', // npm is npm.cmd on Windows
});
process.exit(result.status ?? 1);
