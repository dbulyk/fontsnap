// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { registerBackground } from '../../src/background/handlers';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { initResult } from '../../src/result/app';
import { startSelection } from '../../src/select/overlay';
import { initWelcome } from '../../src/welcome/app';
import '../../src/background/index';
import '../../src/result/index';
import '../../src/select/index';
import '../../src/welcome/index';

// Each entry point calls exactly one function of its area; that function is replaced here so that
// importing the entry point only proves the wiring.
vi.mock('../../src/result/app', () => ({ initResult: vi.fn() }));
vi.mock('../../src/background/handlers', () => ({
  registerBackground: vi.fn(),
}));
vi.mock('../../src/welcome/app', () => ({ initWelcome: vi.fn() }));
vi.mock('../../src/select/overlay', () => ({ startSelection: vi.fn() }));

describe('entry points', () => {
  it('each bootstraps its area once', () => {
    expect(initResult).toHaveBeenCalledExactlyOnceWith(document);
    expect(initWelcome).toHaveBeenCalledExactlyOnceWith(document);
    expect(startSelection).toHaveBeenCalledExactlyOnceWith(window);
    expect(registerBackground).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('src/*/index.ts stays thin', () => {
  const entries = readdirSync('src', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/${entry.name}/index.ts`)
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    });

  it('exist for every extension area: the background, the selection script and each page', () => {
    const pageAreas = Object.values(EXTENSION_PAGES).map((page) => page.split('/')[0] ?? '');
    const expected = ['background', 'select', ...pageAreas]
      .sort()
      .map((area) => `src/${area}/index.ts`);
    expect(entries).toEqual(expected);
  });

  /** Statements of a bootstrap file that are not imports. */
  function others(file: string): ts.Statement[] {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    return source.statements.filter((statement) => !ts.isImportDeclaration(statement));
  }

  /** The call a bootstrap file makes (`run(document)` or `void run(document)`), or why it is not one. */
  function bootstrapCall(file: string): ts.CallExpression | string {
    const statements = others(file);
    const [statement] = statements;
    if (
      statements.length !== 1 ||
      statement === undefined ||
      !ts.isExpressionStatement(statement)
    ) {
      return 'exactly one statement besides imports, and it must be a call';
    }
    const { expression } = statement;
    const call = ts.isVoidExpression(expression) ? expression.expression : expression;
    if (!ts.isCallExpression(call)) return 'the statement is not a call';
    if (!ts.isIdentifier(call.expression)) return 'the callee is not a plain function';
    if (!call.arguments.every((argument) => ts.isIdentifier(argument)))
      return 'arguments must be plain names';
    return call;
  }

  it.each(entries)('%s is imports plus one call', (file) => {
    const result = bootstrapCall(file);
    expect(typeof result === 'string' ? `${file}: ${result}` : 'ok').toBe('ok');
  });

  it('rejects logic: the checker would see a second statement', () => {
    const source = ts.createSourceFile(
      'x.ts',
      "import './a';\nrun();\nconst x = 1;\n",
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      source.statements.filter((statement) => !ts.isImportDeclaration(statement)),
    ).toHaveLength(2);
  });
});
