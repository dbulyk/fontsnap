/**
 * Decodes a `data:` URL into a Blob without the network. `fetch(dataUrl)` is a request, and the extension pages' CSP says
 * `connect-src 'self'` (src/manifest.ts): a `data:` URL is not 'self', so the request is refused. The bytes are the same
 * ones `fetch` returns (WHATWG Fetch, "data: URL processor"); a malformed URL throws, as the fetch rejected.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SIX_BITS = new Map<number, number>();
for (let index = 0; index < ALPHABET.length; index++)
  SIX_BITS.set(ALPHABET.charCodeAt(index), index);
const WHITESPACE = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const EQUALS = 0x3d;

/** The character codes of a base64 payload: %XX is the code it names, ASCII whitespace is dropped (WHATWG Fetch percent-decodes first, Infra drops whitespace). */
function base64Codes(text: string): number[] {
  const codes: number[] = [];
  for (let at = 0; at < text.length; at++) {
    let code = text.charCodeAt(at);
    if (code === 0x25 && /^[0-9a-fA-F]{2}$/.test(text.slice(at + 1, at + 3))) {
      code = Number.parseInt(text.slice(at + 1, at + 3), 16);
      at += 2;
    }
    if (!WHITESPACE.has(code)) codes.push(code);
  }
  return codes;
}

/** forgiving-base64 decode (WHATWG Infra): one or two '=' may end a length divisible by 4. */
function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const codes = base64Codes(text);
  if (codes.length % 4 === 0) {
    for (let drop = 0; drop < 2 && codes.at(-1) === EQUALS; drop++) codes.pop();
  }
  if (codes.length % 4 === 1 || codes.some((code) => !SIX_BITS.has(code))) {
    throw new TypeError('The data: URL is not valid base64');
  }
  const out = new Uint8Array(Math.floor((codes.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const code of codes) {
    bits = ((bits << 6) | (SIX_BITS.get(code) ?? 0)) & 0xffffff;
    held += 6;
    if (held >= 8) {
      held -= 8;
      out[at++] = (bits >> held) & 0xff;
    }
  }
  return out;
}

/** Percent-decodes to bytes: %XX is a byte, any other character is its UTF-8. */
function decodePercent(text: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  for (const part of text.split(/(%[0-9a-fA-F]{2})/)) {
    if (/^%[0-9a-fA-F]{2}$/.test(part)) {
      bytes.push(Number.parseInt(part.slice(1), 16));
      continue;
    }
    // encodeURIComponent writes every non-ASCII character as its UTF-8 %XX
    for (const piece of encodeURIComponent(part).split(/(%[0-9A-F]{2})/)) {
      if (/^%[0-9A-F]{2}$/.test(piece)) bytes.push(Number.parseInt(piece.slice(1), 16));
      else for (const char of piece) bytes.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(bytes);
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(dataUrl);
  if (match === null) throw new TypeError('Not a data: URL');
  const head = match[1] ?? '';
  const payload = (match[2] ?? '').replace(/#[\s\S]*$/, '');
  const base64 = /;\s*base64\s*$/i.test(head);
  const type = (base64 ? head.replace(/;\s*base64\s*$/i, '') : head).trim();
  const bytes = base64 ? decodeBase64(payload) : decodePercent(payload);
  return new Blob([bytes], {
    type: type === '' ? 'text/plain;charset=US-ASCII' : type.toLowerCase(),
  });
}
