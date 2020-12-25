/**
 * @module objects
 */

function isObjectObject(val: unknown): boolean {
  return val != null && typeof val === "object" && Array.isArray(val) === false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isPlainObject(o: any): boolean {
  if (isObjectObject(o) === false) return false;

  // If has modified constructor
  const ctor = o.constructor;
  if (typeof ctor !== "function") return false;

  // If has modified prototype
  const prot = ctor.prototype;
  if (isObjectObject(prot) === false) return false;

  // If constructor does not have an Object-specific method
  if (prot.hasOwnProperty("isPrototypeOf") === false) {
    return false;
  }

  // Most likely a plain Object
  return true;
}

export function mapValues<T, R>(obj: {[key: string]: T}, iteratee: (value: T, key: string) => R): {[key: string]: R} {
  const output: {[key: string]: R} = {};
  for (const [key, value] of Object.entries(obj)) {
    output[key] = iteratee(value, key);
  }
  return output;
}