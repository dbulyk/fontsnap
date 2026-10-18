/** A value that must exist: a missing element fails the test with a message instead of an `undefined` later. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}
