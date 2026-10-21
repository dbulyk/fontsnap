import { describe, expect, it } from 'vitest';
import {
  MAX_PREVIEW_GRAPHEMES,
  acceptCapturedText,
  graphemeCount,
  fieldFromCapture,
  sliceGraphemes,
} from '../../src/shared/graphemes';

describe('graphemeCount', () => {
  it('counts Latin, Cyrillic, Arabic, Japanese and ZWJ emoji as clusters', () => {
    expect(graphemeCount('abc')).toBe(3);
    expect(graphemeCount('Привет')).toBe(6);
    expect(graphemeCount('مرحبا')).toBe(5);
    expect(graphemeCount('こんにちは')).toBe(5);
    expect(graphemeCount('👩‍👩‍👧‍👦')).toBe(1);
  });
});

describe('sliceGraphemes', () => {
  it('accepts exactly 100 and truncates 101 without splitting a cluster', () => {
    const hundred = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(sliceGraphemes(hundred, MAX_PREVIEW_GRAPHEMES)).toBe(hundred);
    expect(sliceGraphemes(hundred + 'b', MAX_PREVIEW_GRAPHEMES)).toBe(hundred);
    expect(sliceGraphemes('x'.repeat(500), MAX_PREVIEW_GRAPHEMES)).toHaveLength(
      MAX_PREVIEW_GRAPHEMES,
    );
    const emoji = '👩‍👩‍👧‍👦';
    const filled = emoji.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(graphemeCount(sliceGraphemes(filled + emoji, MAX_PREVIEW_GRAPHEMES))).toBe(
      MAX_PREVIEW_GRAPHEMES,
    );
    const tail = `${'a'.repeat(99)}${emoji}`;
    expect(sliceGraphemes(tail, 99)).toBe('a'.repeat(99));
    expect(sliceGraphemes(tail, 100)).toBe(tail);
    expect(graphemeCount('e\u0301')).toBe(1);
    expect(sliceGraphemes('e\u0301x', 1)).toBe('e\u0301');
  });
});

describe('fieldFromCapture', () => {
  it('uses captured text at the limit and empties the field when longer', () => {
    const hundred = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(fieldFromCapture(hundred)).toBe(hundred);
    expect(fieldFromCapture(hundred + 'x')).toBe('');
    expect(fieldFromCapture('  ')).toBe('');
    expect(fieldFromCapture(null)).toBe('');
  });

  it('empties the field when normalized capture is over the limit (three paragraphs)', () => {
    expect(fieldFromCapture(`${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(60)}`)).toBe(
      '',
    );
    expect(fieldFromCapture(`${'x'.repeat(100)} ${'y'.repeat(10)}`)).toBe('');
  });

  it('returns the fallback when capture is empty or past the limit', () => {
    const hundred = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(acceptCapturedText(hundred, 'sample')).toBe(hundred);
    expect(acceptCapturedText(`${hundred}x`, 'sample')).toBe('sample');
    expect(acceptCapturedText('   ', 'sample')).toBe('sample');
    expect(acceptCapturedText(null, 'sample')).toBe('sample');
  });
});
