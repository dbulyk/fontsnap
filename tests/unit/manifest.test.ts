import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildManifest, EXTENSION_PAGES_CSP } from '../../src/manifest';
import { BACKGROUND_FILE, CONTENT_SCRIPT_FILE, EXTENSION_PAGES } from '../../src/shared/constants';
import { expectedManifest } from '../../scripts/lib/expected-manifest';

describe('buildManifest', () => {
  const manifest = buildManifest({ version: '0.1.0' });

  it('equals the expected release manifest, key for key', () => {
    expect(manifest).toEqual(expectedManifest('0.1.0'));
  });

  it('echoes the version it is given', () => {
    expect(buildManifest({ version: '1.2.3' }).version).toBe('1.2.3');
  });

  it('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background).toEqual({
      service_worker: 'background.js',
      type: 'module',
    });
    expect(manifest.background?.service_worker).toBe(BACKGROUND_FILE);
  });

  it('requests exactly four permissions and no host access', () => {
    expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'contextMenus']);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.minimum_chrome_version).toBeUndefined();
  });

  it('adds only a loopback host permission for the e2e build', () => {
    expect(buildManifest({ version: '0.1.0', e2e: true }).host_permissions).toEqual([
      'http://127.0.0.1/*',
    ]);
    expect(buildManifest({ version: '0.1.0', e2e: true })).toEqual({
      ...manifest,
      host_permissions: ['http://127.0.0.1/*'],
    });
  });

  it('takes user-visible strings from _locales and keeps the brand name', () => {
    expect(manifest.name).toBe('__MSG_appName__');
    expect(manifest.short_name).toBe('FontSnap');
    expect(manifest.description).toBe('__MSG_appDesc__');
    expect(manifest.action?.default_title).toBe('__MSG_actionTitle__');
    expect(manifest.default_locale).toBe('en');
  });

  it('opens the toolbar action with Alt+Shift+F', () => {
    expect(manifest.commands).toEqual({
      _execute_action: { suggested_key: { default: 'Alt+Shift+F' } },
    });
  });

  it('points at icon files that exist: action 16/32/48, manifest 16/32/48/64/96/128', () => {
    expect(Object.keys(manifest.action?.default_icon ?? {})).toEqual(['16', '32', '48']);
    expect(Object.keys(manifest.icons ?? {})).toEqual(['16', '32', '48', '64', '96', '128']);
    const expected = expectedManifest('0.1.0');
    for (const icon of [
      ...Object.values(expected.icons),
      ...Object.values(expected.action.default_icon),
    ]) {
      expect(existsSync(`public/${icon}`), icon).toBe(true);
    }
  });

  it('declares the pages and the injected script it ships', () => {
    for (const page of Object.values(EXTENSION_PAGES))
      expect(existsSync(`src/${page}`), page).toBe(true);
    expect(CONTENT_SCRIPT_FILE).toBe('select.js');
  });

  it("has exactly the CSP FontSnap needs: 'wasm-unsafe-eval' for onnxruntime-web, nothing else", () => {
    expect(EXTENSION_PAGES_CSP).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'",
    );
    expect(manifest.content_security_policy).toEqual({
      extension_pages: EXTENSION_PAGES_CSP,
    });
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    // 'unsafe-eval' would allow eval() and new Function(); 'wasm-unsafe-eval' allows WebAssembly only.
    expect(csp.replace("'wasm-unsafe-eval'", '')).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/\*|unsafe-inline|data:|blob:/);
    // the only origins outside the extension are the two Google Fonts hosts of the font previews: the stylesheet and the files
    expect(csp.match(/https?:\/\/[^\s;]+/g)).toEqual([
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
    ]);
    // everything else falls back to default-src 'self'; connect-src 'self' keeps every request inside the extension; object-src and
    // base-uri 'none' close the plugin and the <base> doors. A directive that is absent allows everything for its kind.
    const directives = csp.split('; ').map((directive) => directive.split(' ')[0]);
    expect(directives).toEqual([
      'default-src',
      'script-src',
      'connect-src',
      'style-src',
      'font-src',
      'object-src',
      'base-uri',
    ]);
    expect(csp).toMatch(/^default-src 'self'; /);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("style-src 'self' https://fonts.googleapis.com;");
    expect(csp).toContain('font-src https://fonts.gstatic.com;');
    expect(csp).toContain("object-src 'none';");
    expect(csp).toContain("base-uri 'none'");
    // no img-src, worker-src, frame-src, ...: nothing loads an image from data:/blob: and the workers are files of the extension
    expect(csp).not.toMatch(/img-src|worker-src|frame-src|media-src|child-src|form-action/);
  });

  it('is cross-origin isolated with credentialless COEP (Google Fonts previews keep loading)', () => {
    expect(manifest.cross_origin_embedder_policy).toEqual({
      value: 'credentialless',
    });
    expect(manifest.cross_origin_opener_policy).toEqual({
      value: 'same-origin',
    });
  });

  // Pins the full set of manifest keys: a new capability (web_accessible_resources,
  // externally_connectable, optional_permissions, content_scripts, ...) needs a deliberate edit of this
  // list, visible in the diff.
  it('has exactly the expected manifest keys', () => {
    const keys = [
      'action',
      'background',
      'commands',
      'content_security_policy',
      'cross_origin_embedder_policy',
      'cross_origin_opener_policy',
      'default_locale',
      'description',
      'icons',
      'manifest_version',
      'name',
      'permissions',
      'short_name',
      'version',
    ];
    expect(Object.keys(manifest).sort()).toEqual(keys);
    expect(Object.keys(buildManifest({ version: '0.1.0', e2e: true })).sort()).toEqual(
      [...keys, 'host_permissions'].sort(),
    );
  });

  it('exposes no extension page or file to web pages', () => {
    // A web_accessible_resources entry would let a hostile page frame an extension page and the
    // sender policy would then see a "legitimate" extension page.
    for (const e2e of [false, true]) {
      const built = buildManifest({ version: '0.1.0', e2e });
      expect(built.web_accessible_resources).toBeUndefined();
      expect(built.externally_connectable).toBeUndefined();
    }
  });
});
