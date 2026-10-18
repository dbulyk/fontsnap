import ts from 'typescript';

/**
 * What a source file can DO, as sorted lists of what it mentions: everything it calls or constructs, every string it
 * contains, every property it reads or writes, every operator and construct that branches or decodes. A file whose
 * lists are pinned in a test cannot gain a call (decodeURI, atob, Object.freeze, ...), a literal (a URL), a
 * condition on the environment or a new global without that test changing, which a reviewer sees.
 */
export interface Surface {
  calls: string[];
  strings: string[];
  accesses: string[];
  identifiers: string[];
  conditionals: number;
  operators: string[];
  constructs: string[];
}

const unique = (items: string[]): string[] => [...new Set(items)].sort();

export function surfaceOf(text: string): Surface {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  const strings: string[] = [];
  const accesses: string[] = [];
  const identifiers: string[] = [];
  const operators: string[] = [];
  const constructs: string[] = [];
  let conditionals = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    if (ts.isNewExpression(node)) calls.push(`new ${node.expression.getText(source)}`);
    if (ts.isTaggedTemplateExpression(node)) constructs.push('tagged template');
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      strings.push(node.text);
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      strings.push(node.text);
    if (ts.isPropertyAccessExpression(node)) accesses.push(node.getText(source));
    if (ts.isElementAccessExpression(node)) accesses.push(node.getText(source));
    if (ts.isIdentifier(node)) identifiers.push(node.text);
    if (ts.isConditionalExpression(node)) conditionals++;
    if (ts.isBinaryExpression(node)) operators.push(node.operatorToken.getText(source));
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      operators.push(ts.tokenToString(node.operator) ?? '?');
    }
    if (ts.isTypeOfExpression(node)) operators.push('typeof');
    if (ts.isDeleteExpression(node)) operators.push('delete');
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) constructs.push('spread');
    if (ts.isObjectLiteralExpression(node)) constructs.push('object literal');
    if (ts.isArrayLiteralExpression(node)) constructs.push('array literal');
    if (ts.isAwaitExpression(node)) constructs.push('await');
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      constructs.push('function expression');
    if (ts.isTryStatement(node)) constructs.push('try');
    if (ts.isElementAccessExpression(node)) constructs.push('element access');
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    calls: unique(calls),
    strings: unique(strings),
    accesses: unique(accesses),
    identifiers: unique(identifiers),
    conditionals,
    operators: unique(operators),
    constructs: unique(constructs),
  };
}

/** The text of a top-level function, comments removed and formatting normalized, so that a test can pin it exactly. */
export function functionText(text: string, name: string): string {
  const source = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  for (const statement of source.statements) {
    const declared = ts.isFunctionDeclaration(statement)
      ? statement.name?.text
      : ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
            .map((declaration) => (ts.isIdentifier(declaration.name) ? declaration.name.text : ''))
            .join()
        : undefined;
    if (declared === name)
      return printer
        .printNode(ts.EmitHint.Unspecified, statement, source)
        .replace(/\s+/g, ' ')
        .trim();
  }
  throw new Error(`no top-level function or constant ${name}`);
}
