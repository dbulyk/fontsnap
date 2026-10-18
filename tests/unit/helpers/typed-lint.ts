import { join } from 'node:path';
import { ESLint, Linter } from 'eslint';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { fontsnapPlugin } from '../../../eslint.config.js';

// Runs the type-aware rules of eslint.config.js on a fixture that does not exist on disk: a TypeScript program is made in memory
// (the options of tsconfig.src.json, the real lib.dom.d.ts, src/env.d.ts, @types/chrome) with the fixture as one more file, and
// handed to the parser as `programs`. The library files are parsed once and shared by all programs.
const ROOT = process.cwd();
const config = ts.readConfigFile(join(ROOT, 'tsconfig.src.json'), (path) => ts.sys.readFile(path));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
const libraries = new Map<string, ts.SourceFile>();
const eslint = new ESLint();
let previous: ts.Program | undefined;

function programFor(path: string, code: string): ts.Program {
  const host = ts.createCompilerHost(options);
  const real = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => {
    if (name === path) return ts.createSourceFile(name, code, languageVersion, true);
    if (!name.includes(`${ROOT}/src/`)) {
      const known = libraries.get(name);
      if (known) return known;
      const file = real(name, languageVersion, ...rest);
      if (file) libraries.set(name, file);
      return file;
    }
    return real(name, languageVersion, ...rest);
  };
  const program = ts.createProgram([path, join(ROOT, 'src', 'env.d.ts')], options, host, previous);
  previous = program;
  return program;
}

/** Messages of the type-aware rule `fontsnap/dom-members` for `code` as if it were the file `file`. */
export async function domMembers(file: string, code: string): Promise<string[]> {
  const path = join(ROOT, file);
  const configured = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  const entry = configured.rules?.['fontsnap/dom-members'];
  if (entry === undefined) throw new Error(`${file} is not held to fontsnap/dom-members`);
  const program = programFor(path, code);
  return new Linter()
    .verify(
      code,
      [
        {
          files: ['**/*.ts'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { programs: [program] },
          },
          plugins: { fontsnap: fontsnapPlugin },
          rules: { 'fontsnap/dom-members': entry },
        },
      ],
      path,
    )
    .map((message) => message.message);
}
