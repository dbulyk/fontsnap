import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as prettier from 'prettier';

export interface PrettierState {
  /** The configuration Prettier resolves for the repository root (package.json). */
  config: Record<string, unknown> | null;
  /** Files Prettier could format but ignores (via .gitignore or .prettierignore): `format:check` skips them. */
  ignored: string[];
  /** Files for which Prettier resolves a different config than for the root (nested config, editorconfig, "prettier" key). */
  mismatched: string[];
}

/**
 * What `prettier --check .` really does with each file, the way the CLI decides it: ignore files
 * are `.gitignore` and `.prettierignore`, editorconfig counts. A file is only checked when it is not
 * ignored, and with the same configuration as everything else.
 */
export async function inspectPrettier(
  root: string,
  files: readonly string[],
): Promise<PrettierState> {
  const ignorePath = ['.gitignore', '.prettierignore']
    .map((name) => join(root, name))
    .filter((path) => existsSync(path));
  const options = { editorconfig: true };
  const config = await prettier.resolveConfig(join(root, 'package.json'), options);
  const ignored: string[] = [];
  const mismatched: string[] = [];
  for (const file of files) {
    const path = join(root, file);
    // An ignored file reports no parser, so ask without the ignore files whether Prettier supports it.
    if ((await prettier.getFileInfo(path)).inferredParser === null) continue;
    if ((await prettier.getFileInfo(path, { ignorePath })).ignored) {
      ignored.push(file);
    } else if (!isDeepStrictEqual(await prettier.resolveConfig(path, options), config)) {
      mismatched.push(file);
    }
  }
  return { config, ignored: ignored.sort(), mismatched: mismatched.sort() };
}
