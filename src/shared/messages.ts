import { parseHint, parseLangTag, validRect, type Rect } from './capture';
import { graphemeCount } from './graphemes';

/** Hostile-input ceiling for fontsnap-rect.text (graphemes). Above the product gate of 100. */
const MESSAGE_TEXT_CAP = 500;
/** Hostile-input size bound in UTF-16 code units (a single grapheme can be arbitrarily long). */
const MESSAGE_TEXT_UNITS = 2000;

/**
 * Every request any context can send. Add a member here, then `tsc` points at the
 * validator table and the response map below that must be extended too.
 */
export interface Request {
  /** The selection overlay (content script, injected on demand) → service worker. */
  type: 'fontsnap-rect';
  /** Viewport rectangle in CSS pixels. */
  rect: Rect;
  /** window.devicePixelRatio; NaN when the sender did not send a number (the handler falls back to 1). */
  dpr: number;
  /**
   * Text of the page under the selection (preview sample). Hostile input: length is gated on the
   * result page (100 graphemes); a safety cap applies here.
   */
  text: string;
  /** Optional BCP 47 language from the page. */
  lang?: string;
  /** Optional script hint (not shown as preview text). */
  hint?: string;
}

export type RequestType = Request['type'];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

export interface ResponseDataMap {
  'fontsnap-rect': { opened: true };
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

export type ParseResult = { ok: true; request: Request } | { ok: false; error: string };

/**
 * Who is allowed to send a request:
 * - `extension-page`: another page of this extension (URL and origin under chrome-extension://<our id>);
 * - `content-script`: a content script in the top frame of a tab, i.e. code running inside a web
 *   page (sub-frames are not accepted; that would be a new, deliberate kind).
 * Anything a web page can influence must be treated as untrusted, so the default for new request
 * types is `extension-page`.
 */
export type SenderKind = 'extension-page' | 'content-script';

type Fields = Record<string, unknown>;

interface Validator<T extends RequestType> {
  /** Senders allowed to send this request; checked by `onMessage` before anything else. */
  from: readonly SenderKind[];
  /** Builds the typed request from an object already known to have this `type`. */
  parse: (raw: Fields) => RequestOf<T> | undefined;
  isData: (raw: unknown) => raw is ResponseDataMap[T];
}

function isRecord(raw: unknown): raw is Fields {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

// `satisfies` over a mapped type: a new RequestType without an entry fails typecheck.
const validators = {
  'fontsnap-rect': {
    // The overlay is injected into the user's tab by the service worker, so it is the only sender. The
    // payload is hostile input (a page can fake what its own script sends, never who the sender is):
    // it only ever triggers a screenshot of the tab the user invoked FontSnap on and a result tab.
    from: ['content-script'],
    parse: (raw) => {
      if (!validRect(raw['rect'])) return undefined;
      // Hostile input: over the unit or grapheme bound → empty (automatic sample). Never truncate
      // (slice would split surrogates / zalgo clusters and leak a fragment into the field).
      const rawText = typeof raw['text'] === 'string' ? raw['text'] : '';
      const text =
        rawText.length > MESSAGE_TEXT_UNITS || graphemeCount(rawText) > MESSAGE_TEXT_CAP
          ? ''
          : rawText;
      const lang = parseLangTag(raw['lang']);
      const hint = parseHint(raw['hint']);
      return {
        type: 'fontsnap-rect',
        rect: raw['rect'],
        dpr: typeof raw['dpr'] === 'number' ? raw['dpr'] : NaN,
        text,
        ...(lang ? { lang } : {}),
        ...(hint ? { hint } : {}),
      };
    },
    isData: (raw): raw is { opened: true } => isRecord(raw) && raw['opened'] === true,
  },
} satisfies { [T in RequestType]: Validator<T> };

export function allowedSenders(type: RequestType): readonly SenderKind[] {
  return validators[type].from;
}

export function isKnownType(raw: unknown): raw is { type: RequestType } {
  return isRecord(raw) && typeof raw['type'] === 'string' && Object.hasOwn(validators, raw['type']);
}

export function parseRequest(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, error: 'Message must be an object' };
  if (!isKnownType(raw)) return { ok: false, error: 'Unknown message type' };
  const parse: (fields: Fields) => Request | undefined = validators[raw.type].parse;
  const request = parse(raw);
  return request ? { ok: true, request } : { ok: false, error: `Invalid "${raw.type}" request` };
}

export function isResponse<T extends RequestType>(
  type: T,
  raw: unknown,
): raw is Response<ResponseDataMap[T]> {
  if (!isRecord(raw)) return false;
  if (raw['ok'] === false) return typeof raw['error'] === 'string';
  return raw['ok'] === true && validators[type].isData(raw['data']);
}
