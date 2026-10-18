/**
 * The release manifest of FontSnap, written out by hand. manifest.test.ts compares buildManifest() with it
 * and dist.test.ts checks that verifyDist accepts exactly this file; so a change of a permission, the CSP,
 * the cross-origin isolation policy, the shortcut or an icon has to be made here on purpose.
 */
export function expectedManifest(version: string) {
  return {
    manifest_version: 3,
    name: '__MSG_appName__',
    short_name: 'FontSnap',
    version,
    description: '__MSG_appDesc__',
    default_locale: 'en',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'],
    background: { service_worker: 'background.js', type: 'module' },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
      },
    },
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '64': 'icons/icon-64.png',
      '96': 'icons/icon-96.png',
      '128': 'icons/icon-128.png',
    },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+F' } },
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    cross_origin_embedder_policy: { value: 'credentialless' },
    cross_origin_opener_policy: { value: 'same-origin' },
  };
}
