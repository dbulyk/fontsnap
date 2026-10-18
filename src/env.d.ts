/// <reference types="vite/client" />

/** The marker of a window that already shows the selection overlay (src/select/overlay.ts), the only property FontSnap adds. */
interface Window {
  __fontsnapActive?: boolean;
}
