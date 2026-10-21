import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16) / 255;
  const g = Number.parseInt(h.slice(2, 4), 16) / 255;
  const b = Number.parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

describe('result.css preview limit bar', () => {
  it('keeps warn fill ≥ 3:1 against the track (WCAG 1.4.11)', () => {
    const css = readFileSync(new URL('../../src/result/result.css', import.meta.url), 'utf8');
    const track = /\.pv-limit-bar\s*\{[^}]*background:\s*(#[0-9a-fA-F]{3,8})/.exec(css)?.[1];
    const warn = /\.pv-limit-bar\.warn i\s*\{[^}]*background:\s*(#[0-9a-fA-F]{3,8})/.exec(css)?.[1];
    expect(track).toMatch(/^#/);
    expect(warn).toMatch(/^#/);
    if (track === undefined || warn === undefined) throw new Error('missing colors');
    expect(contrast(warn, track)).toBeGreaterThanOrEqual(3);
  });
});
