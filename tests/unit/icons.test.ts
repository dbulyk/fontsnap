import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SIGNATURE = '89504e470d0a1a0a';

/** sha256 of the six icons FontSnap has always shipped; the files only changed their names (icon16.png → icon-16.png). */
const ICON_SHA256 = new Map([
  [16, 'e0c31081baf818f71a8319583e53a536621f263bf2da17da4020a9811fa5d518'],
  [32, '3c33c9600d0c945fa9c1dfd57af9d2ea528c0e3f4424cce0ec3e70c568420f82'],
  [48, '774667de634502c56f5f0a2c1e9671bb6e7e2ffbff06a792dad726ef1f81ff49'],
  [64, 'cbad41fe3d72e57671849db700a374d38e92940ded0845bbb661f4898e7a7257'],
  [96, '177a6ef24853d84d5951e4a17e916783eb781902606188a16fc3b2467b16778c'],
  [128, 'f17a44a8d1d1719fdab16fddef3a65cc990e8b50368369dbbb6571e6e1ea91fb'],
]);

describe('committed icons', () => {
  it('are exactly the sizes the manifest names', () => {
    expect([...ICON_SHA256.keys()]).toEqual([16, 32, 48, 64, 96, 128]);
  });

  it.each([...ICON_SHA256])(
    'icon-%i.png is a PNG of that size with the shipped bytes',
    (size, sha) => {
      const png = readFileSync(`public/icons/icon-${String(size)}.png`);
      expect(png.subarray(0, 8).toString('hex')).toBe(SIGNATURE);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      expect(createHash('sha256').update(png).digest('hex')).toBe(sha);
    },
  );
});
