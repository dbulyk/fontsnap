import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HERE = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const RAW = `${HERE}out/raw`;

/** The unzipped release zip from CI: the graphics show the real package. */
export function extensionDir(): string {
  const ext = process.env['EXT'];
  if (ext === undefined || ext === '') throw new Error('Set EXT to the unzipped extension folder.');
  return ext;
}

type Messages = Record<string, { message: string } | undefined>;

/** A message of `loc`, or the English one when the locale lacks it. */
export function messages(ext: string, loc: string): (key: string) => string {
  const read = (l: string) =>
    JSON.parse(readFileSync(`${ext}/_locales/${l}/messages.json`, 'utf8')) as Messages;
  const local = read(loc);
  const en = read('en');
  return (key) => {
    const text = local[key]?.message ?? en[key]?.message;
    if (text === undefined) throw new Error(`no message ${key}`);
    return text;
  };
}

/** The fonts the listing graphics were drawn with (per-script Noto fallbacks). */
export function useListingFonts(): void {
  process.env['FONTCONFIG_FILE'] = `${HERE}fonts.conf`;
}
