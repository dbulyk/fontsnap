// Chrome: "one to four dot-separated integers, each between 0 and 65535, non-zero integers
// cannot start with zero". https://developer.chrome.com/docs/extensions/reference/manifest/version
const PART = /^(?:0|[1-9]\d{0,4})$/;
const MAX_PART = 65535;
const MAX_PARTS = 4;

export function isChromeVersion(version: string): boolean {
  const parts = version.split('.');
  return (
    parts.length <= MAX_PARTS && parts.every((part) => PART.test(part) && Number(part) <= MAX_PART)
  );
}

export interface VersionInput {
  packageVersion: string;
  /** Version found in a manifest (generated or built); omitted when there is nothing to compare. */
  manifestVersion?: string;
}

/** package.json is the only place a version is edited; the manifest is generated from it. */
export function checkVersion({ packageVersion, manifestVersion }: VersionInput): string[] {
  const problems: string[] = [];
  if (!isChromeVersion(packageVersion)) {
    problems.push(
      `package.json version "${packageVersion}" is not a valid Chrome extension version: use 1-4 dot-separated integers, each 0-65535, without leading zeros (no pre-release suffix)`,
    );
  }
  if (manifestVersion !== undefined && manifestVersion !== packageVersion) {
    problems.push(
      `package.json version ${packageVersion} does not match manifest version ${manifestVersion}. If dist/ is stale, run "npm run build" first.`,
    );
  }
  return problems;
}
