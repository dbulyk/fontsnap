/** An element the page markup is known to contain: a missing one is a bug, reported by name. */
export function required<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`The page has no ${what}`);
  return value;
}
