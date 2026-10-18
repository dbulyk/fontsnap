import { describe, expect, it } from 'vitest';
import { dataUrlToBlob } from '../../src/shared/data-url';

// The extension pages' CSP has `connect-src 'self'`, so `fetch('data:...')` is refused in the browser. dataUrlToBlob replaces it
// and must give the bytes and the type that the fetch gave. Node's fetch implements the same WHATWG data: URL processor,
// so it is the reference here, byte for byte.
async function viaFetch(url: string): Promise<{ bytes: number[]; type: string }> {
  const blob = await (await fetch(url)).blob();
  return { bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type };
}
async function viaDecoder(url: string): Promise<{ bytes: number[]; type: string }> {
  const blob = dataUrlToBlob(url);
  return { bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type };
}
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state >> 16;
  }
  return out;
}

describe('dataUrlToBlob equals fetch(dataUrl)', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 100, 1000, 65537])(
    'for %s random bytes as base64',
    async (n) => {
      const url = `data:image/png;base64,${b64(pseudoRandom(n, n + 1))}`;
      expect(await viaDecoder(url)).toEqual(await viaFetch(url));
    },
  );

  it.each([
    ['unpadded base64', 'data:image/png;base64,AQID'],
    ['base64 without padding where fetch tolerates it', 'data:image/png;base64,AQI'],
    ['base64 with whitespace', 'data:image/png;base64, AQ ID\n'],
    ['base64 with %3D for the padding', 'data:image/png;base64,AQI%3D'],
    ['a fragment', 'data:image/png;base64,AQID#frag'],
    ['an upper-case scheme and parameter', 'DATA:image/PNG;BASE64,AQID'],
    ['a charset parameter', 'data:text/plain;charset=utf-8;base64,aGk='],
    ['no media type', 'data:;base64,aGk='],
    ['no media type and no base64', 'data:,hello'],
    ['percent-encoded bytes', 'data:application/octet-stream,%89PNG%0D%0A'],
    ['non-ASCII text', 'data:text/plain;charset=utf-8,h%C3%A9llo wörld'],
    ['an empty payload', 'data:image/png;base64,'],
  ])('for %s', async (_what, url) => {
    expect(await viaDecoder(url)).toEqual(await viaFetch(url));
  });

  it.each([
    'data:image/png;base64,A',
    'data:image/png;base64,AQID$',
    'data:image/png;base64,AQ=D',
    'data:image/png;base64,====',
    'data:image/png;base64',
  ])('and rejects what fetch rejects: %s', async (url) => {
    await expect(fetch(url).then((r) => r.blob())).rejects.toThrow();
    expect(() => dataUrlToBlob(url)).toThrow();
  });

  it('refuses what is not a data: URL', () => {
    expect(() => dataUrlToBlob('https://example.com/a.png')).toThrow();
  });

  it('decodes a 6 MB screenshot-sized payload quickly', () => {
    const bytes = pseudoRandom(6_000_000, 7);
    const started = performance.now();
    const blob = dataUrlToBlob(`data:image/png;base64,${b64(bytes)}`);
    expect(blob.size).toBe(bytes.length);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
