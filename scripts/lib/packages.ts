/**
 * Dependencies come from the npm registry and from nowhere else. A `file:` / `link:` / git / URL /
 * `npm:` alias / workspace specifier, or a tarball committed to the repository, brings code into
 * node_modules that a reviewer cannot read in the diff (a `.tgz` is binary) and that srcOnlyPlugin
 * treats like any other dependency. The rule is on the specifiers in package.json and on the
 * `resolved` URLs in package-lock.json.
 */
export const REGISTRY_RULE =
  'Dependencies must be npm registry versions (semver ranges or dist-tags) and package-lock.json must resolve every package from https://registry.npmjs.org/: no file:, link:, git, github, URL, npm: alias, workspace: or tarball specifiers.';

export const REGISTRY_URL = 'https://registry.npmjs.org/';

// One semver comparator: an optional operator, a (partial) version, an optional pre-release and build.
const COMPARATOR =
  /^(?:\^|~|<=|>=|<|>|=)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;
const ARCHIVE = /\.(?:tgz|tar|gz|zip)$/i;

/** Whether a dependency specifier is a semver range, a dist-tag, or (in overrides) a `$name` reference. */
export function isRegistrySpec(spec: string): boolean {
  if (spec.startsWith('$')) return /^\$[A-Za-z0-9@._-]+$/.test(spec);
  if (DIST_TAG.test(spec)) return !ARCHIVE.test(spec);
  return spec.split('||').every((range) =>
    range
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '')
      .every((token) => token === '-' || COMPARATOR.test(token)),
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every specifier under `value` (a name → specifier object, nested for overrides) that is not a registry one. */
function walk(path: string, value: unknown): string[] {
  if (typeof value === 'string') {
    return isRegistrySpec(value)
      ? []
      : [`${path}: ${JSON.stringify(value)} is not a registry version`];
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, inner]) => walk(`${path}.${key}`, inner));
  }
  return [`${path}: ${JSON.stringify(value)} is not a registry version`];
}

const SECTIONS = ['dependencies', 'devDependencies', 'overrides'] as const;

/** Problems with the specifiers of dependencies, devDependencies and overrides (nested) in a package.json. */
export function nonRegistrySpecifiers(pkg: Record<string, unknown>): string[] {
  return SECTIONS.flatMap((section) =>
    Object.hasOwn(pkg, section) ? walk(section, pkg[section]) : [],
  );
}

/** Problems in a parsed package-lock.json: every package resolved from the registry, no links. */
export function lockfileProblems(lock: unknown): string[] {
  if (!isRecord(lock) || !Object.hasOwn(lock, 'packages') || !isRecord(lock['packages'])) {
    return ['package-lock.json has no "packages" (lockfileVersion 2 or 3 is required)'];
  }
  return Object.entries(lock['packages']).flatMap(([path, entry]): string[] => {
    if (!isRecord(entry)) return [`package-lock.json: ${path} is not an object`];
    if (path === '') return nonRegistrySpecifiers(entry);
    const resolved = entry['resolved'];
    if (entry['link'] === true)
      return [`package-lock.json: ${path} is a link, not a registry package`];
    if (typeof resolved !== 'string' || !resolved.startsWith(REGISTRY_URL)) {
      return [
        `package-lock.json: ${path} resolves to ${JSON.stringify(resolved)}, not ${REGISTRY_URL}`,
      ];
    }
    return [];
  });
}
