/**
 * Element `i` of `a`, or a RangeError. The recognition pipeline is dense numeric code whose indexes are
 * correct by construction; `noUncheckedIndexedAccess` still types every read as possibly undefined, and a
 * non-null assertion would hide a real bug as NaN. A read outside the array is a bug here, so it is loud.
 */
export function at<T>(a: ArrayLike<T>, i: number): T {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}

function outside(i: number, length: number): never {
  throw new RangeError(`index ${String(i)} is outside 0..${String(length - 1)}`);
}

// The same check, one function per array type: the hot loops of the pipeline read millions of elements, and a
// single generic `at` sees every typed-array kind at once, which makes each read slow. These stay monomorphic.
export function atU8(a: Uint8Array | Uint8ClampedArray, i: number): number {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}

export function atI32(a: Int32Array, i: number): number {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}

export function atF32(a: Float32Array, i: number): number {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}

export function atF64(a: Float64Array, i: number): number {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}

export function atNum(a: readonly number[], i: number): number {
  const value = a[i];
  if (value === undefined) return outside(i, a.length);
  return value;
}
