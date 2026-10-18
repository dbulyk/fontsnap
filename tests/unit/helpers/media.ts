import { ALLOWED_MEDIA } from '../../../scripts/lib/static-assets';

/** A few bytes that start like each medium of MEDIA_SIGNATURES (a new signature needs a sample here). */
export const MEDIA_SAMPLES: ReadonlyMap<string, Buffer> = new Map([
  ['png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
  ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
  ['gif', Buffer.from('GIF89a')],
  ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
  ['woff2', Buffer.from('wOF2....')],
]);

/**
 * Every name an object inherits, as is and lower-cased (extensions are lower-case), plus
 * `__proto__`: a lookup that reads the prototype chain finds something for each of them.
 */
export const PROTOTYPE_NAMES: readonly string[] = [
  ...new Set(
    Object.getOwnPropertyNames(Object.prototype).flatMap((name) => [name, name.toLowerCase()]),
  ),
  '__proto__',
];

/** Lists `extensions` in ALLOWED_MEDIA while `run` runs, then restores the list. */
export function withMedia(extensions: readonly string[], run: () => void): void {
  const before = new Set(ALLOWED_MEDIA);
  for (const extension of extensions) ALLOWED_MEDIA.add(extension);
  try {
    run();
  } finally {
    ALLOWED_MEDIA.clear();
    for (const extension of before) ALLOWED_MEDIA.add(extension);
  }
}
