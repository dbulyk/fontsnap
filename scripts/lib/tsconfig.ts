import { dirname } from 'node:path';
import ts from 'typescript';

/** A tsconfig as tsc resolves it (extends, include, options); throws if it cannot be read. */
export function parseTsconfig(path: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
}
