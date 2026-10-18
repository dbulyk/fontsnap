import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chooseE2eCommand } from '../../scripts/lib/e2e-command';

const linux = { platform: 'linux' as const, hasXvfbRun: true };

describe('chooseE2eCommand', () => {
  it('uses the real display when there is one', () => {
    expect(chooseE2eCommand({ ...linux, env: { DISPLAY: ':0' } }).script).toBe('test:e2e');
    expect(chooseE2eCommand({ ...linux, env: { WAYLAND_DISPLAY: 'wayland-0' } }).script).toBe(
      'test:e2e',
    );
  });

  it('starts a private Xvfb on Linux without a display', () => {
    const choice = chooseE2eCommand({ ...linux, env: {} });
    expect(choice.script).toBe('test:e2e:xvfb');
    expect(choice.env).toEqual({});
  });

  it('treats an empty DISPLAY as unset and falls through to WAYLAND_DISPLAY', () => {
    expect(
      chooseE2eCommand({
        ...linux,
        env: { DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' },
      }).script,
    ).toBe('test:e2e');
    expect(chooseE2eCommand({ ...linux, env: { DISPLAY: '', WAYLAND_DISPLAY: '' } }).script).toBe(
      'test:e2e:xvfb',
    );
  });

  it('treats an empty DISPLAY as no display', () => {
    expect(chooseE2eCommand({ ...linux, env: { DISPLAY: '' } }).script).toBe('test:e2e:xvfb');
  });

  it('falls back to new headless Chromium on Linux with neither a display nor xvfb-run', () => {
    const choice = chooseE2eCommand({
      platform: 'linux',
      hasXvfbRun: false,
      env: {},
    });
    expect(choice.script).toBe('test:e2e');
    expect(choice.env).toEqual({ PW_HEADLESS: '1' });
    expect(choice.reason).toMatch(/xvfb-run/);
  });

  it('honours an explicit PW_HEADLESS=1 without starting Xvfb', () => {
    expect(chooseE2eCommand({ ...linux, env: { PW_HEADLESS: '1' } })).toMatchObject({
      script: 'test:e2e',
      env: {},
    });
  });

  it.each(['darwin', 'win32'] as const)('uses the native display on %s', (platform) => {
    expect(chooseE2eCommand({ platform, hasXvfbRun: false, env: {} }).script).toBe('test:e2e');
  });
});

describe('check script', () => {
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const steps = (scripts['check'] ?? '').split(' && ');

  it('builds before it checks the version, and ends with e2e that works without a display', () => {
    expect(steps.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(steps.indexOf('npm run check:version')).toBeGreaterThan(steps.indexOf('npm run build'));
    expect(steps.at(-1)).toBe('npm run test:e2e:auto');
  });
});
