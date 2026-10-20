import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';

type Sender = chrome.runtime.MessageSender;

export const EXTENSION_ID = 'test-extension-id';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
/** What Chrome puts into sender.origin for our pages (no trailing slash). */
export const EXTENSION_BARE_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/** What Chrome reports for a message sent by one of the extension's own pages. */
export const EXTENSION_PAGE_SENDER: Sender = {
  id: EXTENSION_ID,
  url: `${EXTENSION_ORIGIN}result/result.html`,
  origin: EXTENSION_BARE_ORIGIN,
};

/** A content script runs inside a web page: it has a tab and the page's URL, never ours. */
export const CONTENT_SCRIPT_SENDER: Sender = {
  id: EXTENSION_ID,
  url: 'https://page.example/article',
  origin: 'https://page.example',
  tab: { id: 5, index: 2, windowId: 9, url: 'https://page.example/article' } as chrome.tabs.Tab,
  frameId: 0,
};

export type InstalledReason = 'install' | 'update' | 'chrome_update' | 'shared_module_update';
type InstalledListener = (details: { reason: InstalledReason }) => unknown;
type MessageListener = (
  message: unknown,
  sender: Sender,
  sendResponse: (response: unknown) => void,
) => unknown;
type TabListener = (tab?: chrome.tabs.Tab) => unknown;
type MenuListener = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => unknown;

interface MessageEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

export interface ChromeStubOptions {
  /** Locale used for `getUILanguage` and for reading the real `public/_locales/<locale>` file. */
  locale?: string;
}

/** Substitutes `$NAME$` placeholders and `$1` style arguments like `chrome.i18n.getMessage`. */
function renderMessage(entry: MessageEntry, substitutions: string[]): string {
  const withNamed = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => {
    const content = entry.placeholders?.[name.toLowerCase()]?.content;
    return content ?? whole;
  });
  return withNamed.replace(
    /\$(\d)/g,
    (_whole, index: string) => substitutions[Number(index) - 1] ?? '',
  );
}

function loadMessages(locale: string): Record<string, MessageEntry> {
  const path = join(process.cwd(), 'public', '_locales', locale, 'messages.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, MessageEntry>;
}

/**
 * An in-memory fake of the chrome.* surface FontSnap uses.
 * `dispatch` mimics chrome's onMessage delivery: the first listener that answers
 * (synchronously, or asynchronously after returning `true`) wins.
 */
export function createChromeStub(options: ChromeStubOptions = {}) {
  const locale = options.locale ?? 'en';
  const session = new Map<string, unknown>();
  const messageListeners = new Set<MessageListener>();
  const installedListeners = new Set<InstalledListener>();
  const actionListeners = new Set<TabListener>();
  const menuListeners = new Set<MenuListener>();
  const settingsListeners = new Set<() => unknown>();
  let messages: Record<string, MessageEntry> | undefined;

  function dispatch(message: unknown, sender: Sender = CONTENT_SCRIPT_SENDER): Promise<unknown> {
    return new Promise((resolve) => {
      const state = { answered: false, pending: false };
      const sendResponse = (response: unknown) => {
        if (!state.answered) {
          state.answered = true;
          resolve(response);
        }
      };
      for (const listener of [...messageListeners]) {
        if (listener(message, sender, sendResponse) === true) state.pending = true;
      }
      if (!state.answered && !state.pending) resolve(undefined);
    });
  }

  const stub = {
    storage: {
      session: {
        get: vi.fn((key: string) =>
          Promise.resolve(session.has(key) ? { [key]: session.get(key) } : {}),
        ),
        set: vi.fn((items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) session.set(key, value);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string) => {
          session.delete(key);
          return Promise.resolve();
        }),
      },
    },
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}${path}`,
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => messageListeners.add(listener)),
        removeListener: vi.fn((listener: MessageListener) => messageListeners.delete(listener)),
      },
      onInstalled: {
        addListener: vi.fn((listener: InstalledListener) => installedListeners.add(listener)),
      },
      sendMessage: vi.fn((message: unknown) => dispatch(message)),
    },
    action: {
      onClicked: { addListener: vi.fn((listener: TabListener) => actionListeners.add(listener)) },
      getUserSettings: vi.fn(() => Promise.resolve({ isOnToolbar: false })),
      onUserSettingsChanged: {
        addListener: vi.fn((listener: () => unknown) => settingsListeners.add(listener)),
      },
    },
    contextMenus: {
      removeAll: vi.fn((callback?: () => void) => {
        callback?.();
      }),
      create: vi.fn<(item: chrome.contextMenus.CreateProperties) => void>(),
      onClicked: { addListener: vi.fn((listener: MenuListener) => menuListeners.add(listener)) },
    },
    tabs: {
      create: vi.fn((properties: chrome.tabs.CreateProperties) =>
        Promise.resolve({ id: 99, ...properties } as chrome.tabs.Tab),
      ),
      captureVisibleTab: vi.fn<
        (
          windowId?: number,
          options?: { format?: 'png' | 'jpeg'; quality?: number },
        ) => Promise<string>
      >(() => Promise.resolve('data:image/png;base64,c2hvdA==')),
      get: vi.fn((tabId: number) =>
        Promise.resolve({ id: tabId, active: true } as chrome.tabs.Tab),
      ),
      sendMessage: vi.fn((_tabId: number, message: unknown) => dispatch(message)),
    },
    scripting: {
      executeScript: vi.fn<(injection: unknown) => Promise<unknown[]>>(() => Promise.resolve([])),
    },
    i18n: {
      getUILanguage: () => locale,
      getMessage: (key: string, substitutions?: string | string[]) => {
        messages ??= loadMessages(locale.split('-')[0] ?? 'en');
        const entry = messages[key];
        if (!entry) return '';
        return renderMessage(
          entry,
          typeof substitutions === 'string' ? [substitutions] : (substitutions ?? []),
        );
      },
    },
  };

  return {
    chrome: stub,
    /** Installs the stub as the global `chrome` (undone by `vi.unstubAllGlobals`). */
    install(): void {
      vi.stubGlobal('chrome', stub);
    },
    dispatch,
    listenerCount: () => messageListeners.size,
    /** How many listeners each event has (they must all be registered synchronously at load). */
    listeners: () => ({
      installed: installedListeners.size,
      actionClicked: actionListeners.size,
      menuClicked: menuListeners.size,
      message: messageListeners.size,
    }),
    /** Fires chrome.runtime.onInstalled with `reason`; resolves when every listener is done. */
    fireInstalled: async (reason: InstalledReason = 'install'): Promise<void> => {
      await Promise.all([...installedListeners].map((listener) => listener({ reason })));
    },
    /** Fires chrome.action.onClicked. */
    fireActionClicked: async (tab?: chrome.tabs.Tab): Promise<void> => {
      await Promise.all([...actionListeners].map((listener) => listener(tab)));
    },
    /** Fires chrome.contextMenus.onClicked. */
    fireMenuClicked: async (
      info: Partial<chrome.contextMenus.OnClickData>,
      tab?: chrome.tabs.Tab,
    ): Promise<void> => {
      await Promise.all(
        [...menuListeners].map((listener) =>
          listener(info as chrome.contextMenus.OnClickData, tab),
        ),
      );
    },
    fireSettingsChanged: (): void => {
      for (const listener of settingsListeners) void listener();
    },
    /** chrome.storage.session contents. */
    session,
  };
}
