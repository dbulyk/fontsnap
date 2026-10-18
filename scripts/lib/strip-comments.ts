import ts from 'typescript';

/** `source` with every real comment blanked out (same length and line breaks), for scanning code only. */
export function stripComments(source: string, fileName: string): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const ranges = new Map<number, number>();
  const add = (found: ts.CommentRange[] | undefined) => {
    for (const range of found ?? []) ranges.set(range.pos, range.end);
  };
  // Comments are trivia attached to tokens: walk every token, so text inside strings, templates and
  // regex literals is never mistaken for a comment.
  const visit = (node: ts.Node) => {
    add(ts.getLeadingCommentRanges(source, node.getFullStart()));
    add(ts.getTrailingCommentRanges(source, node.getEnd()));
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  let result = source;
  for (const [start, end] of ranges) {
    result =
      result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, ' ') + result.slice(end);
  }
  return result;
}
