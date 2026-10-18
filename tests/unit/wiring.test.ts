import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pre-TypeScript suite grepped background.js / result.js; these contracts read the TypeScript sources.
describe('background wiring (source contracts)', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), 'src', file), 'utf8');
  const background = [read('background/shot.ts'), read('background/handlers.ts')].join('\n');
  const result = read('result/app.ts');

  it('background imports capture helpers and does not use Date.now() capture ids', () => {
    expect(background).toMatch(/from ['"]\.\.\/shared\/capture['"]/);
    expect(background).toMatch(/newCaptureId/);
    expect(background).not.toMatch(/'cap_' \+ Date\.now\(\)/);
    expect(background).toMatch(/MAX_IMAGE_BYTES/);
    expect(background).not.toMatch(/MAX_IMAGE_BYTES\s*=\s*25e6/);
  });

  it('background keeps the SW alive across the rect message handler', () => {
    // The shared messaging helper returns true so the channel stays open until sendResponse.
    const messaging = read('shared/messaging.ts');
    expect(messaging).toMatch(/return true/);
    expect(messaging).toMatch(/sendResponse/);
  });

  it('background wraps openResult failures so a result tab still opens', () => {
    expect(background).toMatch(/errorResultHash|planOpenResult/);
    expect(background).toMatch(/assertFitsSessionQuota|MAX_DATA_URL/);
  });

  it('background uses encodeWithinSessionQuota for crop output (JPEG ladder)', () => {
    expect(background).toMatch(/encodeWithinSessionQuota/);
  });

  it('result page surfaces err= hashes without requiring session storage', () => {
    expect(result).toMatch(/parseResultHash|err=/);
  });

  it('install path does not use bare setTimeout for welcome', () => {
    expect(background).not.toMatch(/setTimeout\s*\(\s*async/);
  });
});
