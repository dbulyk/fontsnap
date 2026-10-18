export interface E2eInput {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  hasXvfbRun: boolean;
}

export interface E2eChoice {
  /** npm script to run. */
  script: 'test:e2e' | 'test:e2e:xvfb';
  /** Extra environment for that script. */
  env: Record<string, string>;
  reason: string;
}

/**
 * Picks how to run the headed e2e suite on this machine, so `npm run check` works on a laptop,
 * on a server without a display, and for bots that have neither a display nor Xvfb installed.
 */
export function chooseE2eCommand({ platform, env, hasXvfbRun }: E2eInput): E2eChoice {
  if (env['PW_HEADLESS'] === '1') {
    return { script: 'test:e2e', env: {}, reason: 'PW_HEADLESS=1: new headless Chromium' };
  }
  // An empty variable counts as unset (so `??` would be wrong here).
  const isSet = (name: string) => (env[name] ?? '') !== '';
  const hasDisplay = platform !== 'linux' || isSet('DISPLAY') || isSet('WAYLAND_DISPLAY');
  if (hasDisplay) return { script: 'test:e2e', env: {}, reason: 'a display is available' };
  if (hasXvfbRun) {
    return { script: 'test:e2e:xvfb', env: {}, reason: 'no display: running under a private Xvfb' };
  }
  return {
    script: 'test:e2e',
    env: { PW_HEADLESS: '1' },
    reason:
      'no display and no xvfb-run: falling back to new headless Chromium (install xvfb to run headed)',
  };
}
