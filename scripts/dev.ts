import { spawn, spawnSync } from 'node:child_process';

// A full build first (cleans dist/), then both builds in watch mode.
const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const watchers = [
  spawn('npx', ['vite', 'build', '--configLoader', 'bundle', '-c', 'vite.config.ts', '--watch'], {
    stdio: 'inherit',
  }),
  spawn(
    'npx',
    ['vite', 'build', '--configLoader', 'bundle', '-c', 'vite.content.config.ts', '--watch'],
    { stdio: 'inherit' },
  ),
];
const stop = () => {
  for (const watcher of watchers) watcher.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Watching. Load dist/ at chrome://extensions and reload the extension after changes.');
