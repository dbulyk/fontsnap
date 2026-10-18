import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  THRESHOLD_ENV,
  envNumber,
  loadThresholds,
  parityAgreement,
  type Predictions,
} from '../../scripts/lib/regression';

describe('envNumber', () => {
  it('reads a number, and falls back for an unset or empty variable', () => {
    expect(envNumber({ A: '61.5' }, 'A', 1)).toBe(61.5);
    expect(envNumber({}, 'A', 1)).toBe(1);
    expect(envNumber({ A: '' }, 'A', 1)).toBe(1);
    expect(envNumber({ A: undefined }, 'A', 1)).toBe(1);
    expect(envNumber({ A: '0' }, 'A', 1)).toBe(0);
  });

  it('does not read inherited names as variables', () => {
    expect(envNumber({}, 'constructor', 7)).toBe(7);
  });
});

describe('loadThresholds', () => {
  const file = 'tests/thresholds.json';

  it('keeps the committed defaults: best 59.0/77.5, bare 45.0/69.0, parity 99%', () => {
    expect(loadThresholds({}, file)).toEqual({
      best: { top1: 59.0, top5: 77.5 },
      bare: { top1: 45.0, top5: 69.0 },
      parity: 99.0,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      best: { top1: 59.0, top5: 77.5 },
      bare: { top1: 45.0, top5: 69.0 },
      parityTop1Agreement: 99.0,
    });
  });

  it('names the five environment variables that override them', () => {
    expect(THRESHOLD_ENV).toEqual([
      'FONTSNAP_MIN_BEST_TOP1',
      'FONTSNAP_MIN_BEST_TOP5',
      'FONTSNAP_MIN_BARE_TOP1',
      'FONTSNAP_MIN_BARE_TOP5',
      'FONTSNAP_MIN_PARITY',
    ]);
  });

  it('lets each variable override only its own threshold', () => {
    const env = {
      FONTSNAP_MIN_BEST_TOP1: '50',
      FONTSNAP_MIN_BEST_TOP5: '60',
      FONTSNAP_MIN_BARE_TOP1: '30',
      FONTSNAP_MIN_BARE_TOP5: '40',
      FONTSNAP_MIN_PARITY: '90',
    };
    expect(loadThresholds(env, file)).toEqual({
      best: { top1: 50, top5: 60 },
      bare: { top1: 30, top5: 40 },
      parity: 90,
    });
    expect(loadThresholds({ FONTSNAP_MIN_BARE_TOP5: '41' }, file).bare).toEqual({
      top1: 45.0,
      top5: 41,
    });
    expect(loadThresholds({ FONTSNAP_MIN_BARE_TOP5: '' }, file).bare.top5).toBe(69.0);
  });
});

describe('parityAgreement', () => {
  const preds = (best: string[][], bare: string[][] = best): Predictions =>
    Object.fromEntries(
      best.map((top, i) => [`im${String(i)}.png`, { best: top, bare: bare[i] ?? top }]),
    );

  it('is the share of images whose top-1 family is the same', () => {
    const a = preds([['a'], ['b'], ['c'], ['d']]);
    const b = preds([['a'], ['b'], ['x'], ['d']]);
    expect(parityAgreement(a, b, 'best')).toBe(75);
    expect(parityAgreement(a, a, 'best')).toBe(100);
  });

  it('compares the two configurations separately', () => {
    const a = preds([['a'], ['b']], [['p'], ['q']]);
    const b = preds([['a'], ['b']], [['p'], ['z']]);
    expect(parityAgreement(a, b, 'best')).toBe(100);
    expect(parityAgreement(a, b, 'bare')).toBe(50);
  });

  it('looks at the top-1 only, not at the rest of the list', () => {
    expect(parityAgreement(preds([['a', 'b']]), preds([['a', 'c']]), 'best')).toBe(100);
  });

  it('refuses two sets of images that differ', () => {
    expect(() => parityAgreement(preds([['a']]), preds([['a'], ['b']]), 'best')).toThrow(
      /same images/,
    );
    expect(() =>
      parityAgreement(
        { 'a.png': { best: ['a'], bare: ['a'] } },
        { 'b.png': { best: ['a'], bare: ['a'] } },
        'best',
      ),
    ).toThrow(/same images/);
  });
});
