import {Json, toHexString} from "@chainsafe/ssz";
import {LodestarError} from "./errors";
import {mapValues} from "./objects";

export const CIRCULAR_REFERENCE_TAG = "CIRCULAR_REFERENCE";

export function toJson(arg: unknown, refs = new WeakMap()): Json {
  switch (typeof arg) {
    case "bigint":
    case "symbol":
    case "function":
      return arg.toString();

    case "object":
      if (arg === null) return "null";

      // Prevent recursive loops
      if (refs.has(arg)) {
        return CIRCULAR_REFERENCE_TAG;
      }
      refs.set(arg, true);

      if (arg instanceof Uint8Array) return toHexString(arg);
      if (arg instanceof LodestarError) return toJson(arg.toObject(), refs);
      if (arg instanceof Error) return toJson(errorToObject(arg), refs);
      if (Array.isArray(arg)) return arg.map((item) => toJson(item, refs));
      return mapValues(arg as Record<string, unknown>, (item) => toJson(item, refs));

    // Already valid JSON
    case "number":
    case "string":
    case "undefined":
    case "boolean":
    default:
      return arg as Json;
  }
}

export function toString(json: Json, nested = false): string {
  switch (typeof json) {
    case "object": {
      if (nested) return JSONStringifyCircular(json);
      if (json === null) return "null";
      if (Array.isArray(json)) return json.map((item) => toString(item, true)).join(", ");
      return Object.entries(json)
        .map(([key, value]) => `${key}=${toString(value, true)}`)
        .join(", ");
    }

    case "number":
    case "string":
    case "boolean":
    default:
      return String(json);
  }
}

function errorToObject(err: Error): Json {
  return {
    message: err.message,
    ...(err.stack ? {stack: err.stack} : {}),
  };
}

/**
 * Does not throw on circular references, prevent silencing the actual logged error
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/naming-convention
function JSONStringifyCircular(value: any): string {
  try {
    return JSON.stringify(value);
  } catch (e: unknown) {
    if (e instanceof TypeError && e.message.includes("circular")) {
      return CIRCULAR_REFERENCE_TAG;
    } else {
      throw e;
    }
  }
}
