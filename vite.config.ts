import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import { BACKGROUND_FILE } from './src/shared/constants';
import {
  bundleFilesPlugin,
  manifestPlugin,
  outDirFor,
  pageEntries,
  PUBLIC,
  sharedConfig,
  SRC,
  vendorPlugin,
} from './vite.shared';

// Main build: popup, options (HTML entries) and the ES-module service worker.
// The content script is a separate build (vite.content.config.ts) because it is injected
// as a classic script and therefore cannot import shared chunks.
// What both builds share (plugins, worker pipeline, CSS and env handling) is in sharedConfig().
export default defineConfig(({ mode }) =>
  mergeConfig(sharedConfig(), {
    publicDir: PUBLIC,
    plugins: [
      manifestPlugin({ e2e: mode === 'e2e' }),
      vendorPlugin(),
      bundleFilesPlugin('main', mode),
    ],
    build: {
      outDir: outDirFor(mode),
      // Watch mode keeps the output: the content script build writes into the same directory.
      emptyOutDir: !process.argv.includes('--watch'),
      rolldownOptions: {
        // The pages come from the one declared list; the service worker is not a page.
        input: {
          ...pageEntries(),
          background: resolve(SRC, 'background/index.ts'),
        },
        output: {
          entryFileNames: (chunk: { name: string }) =>
            chunk.name === 'background' ? BACKGROUND_FILE : 'assets/[name]-[hash].js',
        },
      },
    },
  }),
);
