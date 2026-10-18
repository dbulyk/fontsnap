import { errorMessage } from './errors';
import {
  allowedSenders,
  isKnownType,
  parseRequest,
  isResponse,
  type Request,
  type RequestOf,
  type RequestType,
  type Response,
  type ResponseDataMap,
  type SenderKind,
} from './messages';

export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingError';
  }
}

type Sender = chrome.runtime.MessageSender;

export type Handlers = {
  [T in RequestType]?: (
    request: RequestOf<T>,
    sender: Sender,
  ) => ResponseDataMap[T] | Promise<ResponseDataMap[T]>;
};

function unwrap<T extends RequestType>(type: T, raw: unknown): ResponseDataMap[T] {
  if (!isResponse(type, raw)) throw new MessagingError(`Malformed response to "${type}"`);
  if (!raw.ok) throw new MessagingError(raw.error);
  return raw.data;
}

async function deliver<T extends RequestType>(
  type: T,
  send: () => Promise<unknown>,
): Promise<ResponseDataMap[T]> {
  let raw: unknown;
  try {
    raw = await send();
  } catch (error) {
    throw new MessagingError(errorMessage(error));
  }
  return unwrap(type, raw);
}

/** Sends a request to the extension's other contexts (the background service worker). */
export function sendMessage<R extends Request>(request: R): Promise<ResponseDataMap[R['type']]> {
  return deliver<R['type']>(request.type, () => chrome.runtime.sendMessage(request));
}

/** Sends a request to the content script of a tab. */
export function sendTabMessage<R extends Request>(
  tabId: number,
  request: R,
): Promise<ResponseDataMap[R['type']]> {
  return deliver<R['type']>(request.type, () => chrome.tabs.sendMessage(tabId, request));
}

/**
 * Sender policy. `sender.id` must always be this extension.
 * - An extension page is recognised by its URL and its origin (Chrome reports one for every document). `sender.tab`
 *   says nothing by itself (the options page lives in a tab), but a page of ours that is framed
 *   inside a tab (`frameId` other than 0) is refused: that would be one of our pages embedded by a
 *   hostile page, which only works if the manifest exposes it.
 * - A content script is a tab plus a non-extension URL/origin (a web page can never carry ours),
 *   in the top frame.
 */
export function isAllowedSender(kinds: readonly SenderKind[], sender: Sender): boolean {
  if (sender.id === undefined || sender.id !== chrome.runtime.id) return false;
  // getURL('') ends with '/', so "chrome-extension://<id>evil/" does not match.
  const baseUrl = chrome.runtime.getURL('');
  const extensionOrigin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const claimsExtensionUrl = sender.url?.startsWith(baseUrl) === true;
  const claimsExtensionOrigin = sender.origin === extensionOrigin;
  const inTab = sender.tab !== undefined;
  const topFrame = sender.frameId === 0;

  return kinds.some((kind) => {
    switch (kind) {
      case 'extension-page':
        return claimsExtensionUrl && claimsExtensionOrigin && (!inTab || topFrame);
      case 'content-script':
        return inTab && !claimsExtensionUrl && !claimsExtensionOrigin && topFrame;
    }
  });
}

async function run(
  handlers: Handlers,
  request: Request,
  sender: Sender,
): Promise<Response<unknown>> {
  // TS cannot correlate `request.type` with the matching handler; the table is typed per key.
  const handler = handlers[request.type] as
    ((request: Request, sender: Sender) => unknown) | undefined;
  try {
    return { ok: true, data: await handler?.(request, sender) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Registers one runtime.onMessage listener for the given handlers and returns an unsubscribe.
 * Messages whose type this context does not handle are ignored (so another context can answer),
 * and so are messages from a sender the type's policy does not allow (see `isAllowedSender`):
 * they are neither validated nor handled and get no response, which tells an untrusted
 * page nothing about what this extension handles.
 */
export function onMessage(handlers: Handlers): () => void {
  const listener = (
    message: unknown,
    sender: Sender,
    sendResponse: (response: Response<unknown>) => void,
  ): boolean => {
    if (!isKnownType(message) || handlers[message.type] === undefined) return false;
    if (!isAllowedSender(allowedSenders(message.type), sender)) return false;
    const parsed = parseRequest(message);
    if (!parsed.ok) {
      sendResponse({ ok: false, error: parsed.error });
      return false;
    }
    void run(handlers, parsed.request, sender).then(sendResponse);
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    chrome.runtime.onMessage.removeListener(listener);
  };
}
