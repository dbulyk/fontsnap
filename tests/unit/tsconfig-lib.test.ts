import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTsconfig } from '../../scripts/lib/tsconfig';

describe('parseTsconfig', () => {
  it('resolves extends, options and the files an include selects', () => {
    const parsed = parseTsconfig(join(process.cwd(), 'tsconfig.src.json'));
    expect(parsed.options.strict).toBe(true);
    expect(parsed.options.types).toEqual(['chrome']);
    expect(parsed.fileNames.some((file) => file.endsWith('/src/result/app.ts'))).toBe(true);
    expect(parsed.raw).toMatchObject({
      extends: './tsconfig.base.json',
      include: ['src'],
    });
  });

  it('throws for a file that does not exist', () => {
    expect(() => parseTsconfig('does-not-exist.json')).toThrow(/does-not-exist/);
  });
});
