import { resolve } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import { CONTENT_SCRIPT_FILE } from './src/shared/constants';
import { bundleFilesPlugin, outDirFor, sharedConfig, SRC } from './vite.shared';

// Content script: one self-contained IIFE, written next to the main build output. Everything that
// decides how files are processed comes from sharedConfig(), as in the main build.
export default defineConfig(({ mode }) =>
  mergeConfig(sharedConfig(), {
    publicDir: false,
    plugins: [bundleFilesPlugin('content', mode)],
    build: {
      outDir: outDirFor(mode),
      emptyOutDir: false,
      rolldownOptions: {
        input: resolve(SRC, 'select/index.ts'),
        output: {
          format: 'iife',
          name: 'fontsnapSelect',
          entryFileNames: CONTENT_SCRIPT_FILE,
          codeSplitting: false,
        },
      },
    },
  }),
);
