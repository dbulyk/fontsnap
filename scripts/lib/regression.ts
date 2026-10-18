import { readFileSync } from 'node:fs';

/** Per image, the families of the top-5 for each pipeline configuration (key `best`: TTA + prior + merge; `bare`: plain). */
export type Predictions = Record<string, Record<'best' | 'bare', string[]>>;

export interface Thresholds {
  best: { top1: number; top5: number };
  bare: { top1: number; top5: number };
  /** Minimum percentage of images whose top-1 family is the same in JS and Python. */
  parity: number;
}

/** The environment variables that override tests/thresholds.json, in the order best/bare × top1/top5, parity. */
export const THRESHOLD_ENV = [
  'FONTSNAP_MIN_BEST_TOP1',
  'FONTSNAP_MIN_BEST_TOP5',
  'FONTSNAP_MIN_BARE_TOP1',
  'FONTSNAP_MIN_BARE_TOP5',
  'FONTSNAP_MIN_PARITY',
] as const;

/** A number from the environment; an unset or empty variable (CI passes empty ones) means the default. */
export function envNumber(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
): number {
  const value = Object.hasOwn(env, key) ? env[key] : undefined;
  return value !== undefined && value !== '' ? Number(value) : fallback;
}

interface ThresholdFile {
  best: { top1: number; top5: number };
  bare: { top1: number; top5: number };
  parityTop1Agreement: number;
}

/** Thresholds from `file` (tests/thresholds.json), each overridable by its FONTSNAP_MIN_* variable. */
export function loadThresholds(
  env: Readonly<Record<string, string | undefined>>,
  file: string,
): Thresholds {
  const t = JSON.parse(readFileSync(file, 'utf8')) as ThresholdFile;
  return {
    best: {
      top1: envNumber(env, 'FONTSNAP_MIN_BEST_TOP1', t.best.top1),
      top5: envNumber(env, 'FONTSNAP_MIN_BEST_TOP5', t.best.top5),
    },
    bare: {
      top1: envNumber(env, 'FONTSNAP_MIN_BARE_TOP1', t.bare.top1),
      top5: envNumber(env, 'FONTSNAP_MIN_BARE_TOP5', t.bare.top5),
    },
    parity: envNumber(env, 'FONTSNAP_MIN_PARITY', t.parityTop1Agreement),
  };
}

/** Percentage of images whose top-1 family is the same in the two prediction sets for configuration `c`. */
export function parityAgreement(python: Predictions, js: Predictions, c: 'best' | 'bare'): number {
  const images = Object.keys(js);
  const pythonImages = new Set(Object.keys(python));
  if (images.length !== pythonImages.size || images.some((image) => !pythonImages.has(image))) {
    throw new Error('JS and Python results are not for the same images');
  }
  const agree = images.filter((image) => python[image]?.[c][0] === js[image]?.[c][0]).length;
  return (100 * agree) / images.length;
}
