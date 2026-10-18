/**
 * The only files public/ may put into the extension as they are, as paths relative to public/ (which
 * is also how they appear in the build output). Everything else must be produced by the bundler.
 */
const STATIC_ASSET_PATTERNS = [
  /^_locales\/[A-Za-z0-9_-]+\/messages\.json$/,
  /^icons\/icon-\d+\.png$/,
];

export const STATIC_ASSET_RULE =
  'public/ holds only locale messages (_locales/<locale>/messages.json) and PNG icons named icons/icon-<size>.png. ' +
  'Code, pages and other assets (an SVG icon, a font) are not allowed there: bundle them from src/ (a medium ' +
  'needs its type in ALLOWED_MEDIA in scripts/lib/static-assets.ts, see "Allow a media type" in README.md).';

export function isStaticAsset(relativePath: string): boolean {
  return STATIC_ASSET_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/**
 * Magic-byte checks for the media types a template may want to carry, by extension. A Map, like
 * every allowlist here: an extension such as `constructor` must not find anything inherited from
 * Object.prototype. Not allowed by themselves: to allow a type, add its extension to ALLOWED_MEDIA
 * below (the ONLY place to edit; see "Allow a media type" in README.md). A file that does not start
 * like its type is refused, so a script cannot hide under a media name.
 */
export const MEDIA_SIGNATURES: ReadonlyMap<string, (bytes: Buffer) => boolean> = new Map([
  [
    'png',
    (bytes: Buffer) =>
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ],
  ['jpg', (bytes: Buffer) => bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))],
  ['gif', (bytes: Buffer) => bytes.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'webp',
    (bytes: Buffer) =>
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
  ['woff2', (bytes: Buffer) => bytes.subarray(0, 4).toString('latin1') === 'wOF2'],
]);

/**
 * Extensions of the media that may be put in src/ and come out of the build as assets (the
 * signature is MEDIA_SIGNATURES.get(extension); a type without one stays refused). Empty today.
 * SVG, HTML, scripts, JSON, text and WebAssembly can never be listed here: they can carry script,
 * and Chrome runs a `<script src>` whatever the file is called.
 */
export const ALLOWED_MEDIA = new Set<string>();

/** Types that can carry script or code; refused even if someone lists them in ALLOWED_MEDIA. */
export const FORBIDDEN_MEDIA: ReadonlySet<string> = new Set([
  'svg',
  'svgz',
  'html',
  'htm',
  'xhtml',
  'xml',
  'js',
  'mjs',
  'cjs',
  'json',
  'txt',
  'map',
  'wasm',
  'pdf',
  'swf',
]);

const extensionOf = (file: string) => /\.([A-Za-z0-9]+)$/.exec(file)?.[1];

/** The signature check of a file name whose (lower-case) extension is listed in ALLOWED_MEDIA, or undefined. */
function mediaTypeOf(file: string): ((bytes: Buffer) => boolean) | undefined {
  const extension = extensionOf(file);
  if (extension === undefined) return undefined;
  const listed =
    extension === extension.toLowerCase() &&
    !FORBIDDEN_MEDIA.has(extension) &&
    ALLOWED_MEDIA.has(extension);
  return listed ? MEDIA_SIGNATURES.get(extension) : undefined;
}

/** Whether a file under src/ is of a type the build may take: .ts, .html, .css or listed media. */
export function isAllowedSrcFile(file: string): boolean {
  return /\.(?:ts|html|css)$/.test(file) || mediaTypeOf(file) !== undefined;
}

/** Whether `assets/<name>.<ext>` with these bytes is a listed medium (the name AND the bytes decide). */
export function isAllowedDistMedia(file: string, bytes: Buffer): boolean {
  return /^assets\/[A-Za-z0-9_.-]+$/.test(file) && (mediaTypeOf(file)?.(bytes) ?? false);
}

/** Whether `assets/<name>.<ext>` has a listed media extension (before the bytes are read). */
export function hasAllowedMediaExtension(file: string): boolean {
  return /^assets\/[A-Za-z0-9_.-]+$/.test(file) && mediaTypeOf(file) !== undefined;
}
