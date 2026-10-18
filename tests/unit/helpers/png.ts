import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { fromRGBA, type Img } from '../../../src/shared/core/image';

/** Decodes a PNG file the way the evaluation harness does (RGBA → RGB). */
export function loadPng(file: string): Img {
  const png = PNG.sync.read(readFileSync(file));
  return fromRGBA(png.data, png.width, png.height);
}
