import {expect} from "chai";
import {LodestarError, mapValues} from "@chainsafe/lodestar-utils";
import {Json} from "@chainsafe/ssz";

export function expectThrowsLodestarError(fn: () => any, expectedErr: LodestarError<any>): void {
  try {
    const value = fn();
    const json = JSON.stringify(value, null, 2);
    throw Error(`Expected fn to throw but returned value: \n\n\t${json}`);
  } catch (e: unknown) {
    expectLodestarError(e, expectedErr);
  }
}

export async function expectRejectedWithLodestarError(
  promise: Promise<any>,
  expectedErr: LodestarError<any> | string
): Promise<void> {
  try {
    const value = await promise;
    const json = JSON.stringify(value, null, 2);
    throw Error(`Expected promise to reject but returned value: \n\n\t${json}`);
  } catch (e: unknown) {
    if (typeof expectedErr === "string") {
      expectLodestarErrorCode(e, expectedErr);
    } else {
      expectLodestarError(e, expectedErr);
    }
  }
}

export function expectLodestarErrorCode<T extends {code: string}>(err: LodestarError<T>, expectedCode: string): void {
  if (!(err instanceof LodestarError)) throw Error(`err not instanceof LodestarError: ${(err as Error).stack}`);

  const code = err.type.code;
  expect(code).to.deep.equal(expectedCode, "Wrong LodestarError code");
}

export function expectLodestarError<T extends {code: string}>(err1: LodestarError<T>, err2: LodestarError<T>): void {
  if (!(err1 instanceof LodestarError)) throw Error(`err1 not instanceof LodestarError: ${(err1 as Error).stack}`);
  if (!(err2 instanceof LodestarError)) throw Error(`err2 not instanceof LodestarError: ${(err2 as Error).stack}`);

  const errMeta1 = getErrorMetadata(err1);
  const errMeta2 = getErrorMetadata(err2);
  expect(errMeta1).to.deep.equal(errMeta2, "Wrong LodestarError metadata");
}

export function getErrorMetadata<T extends {code: string}>(err: LodestarError<T> | Error | Json): Json {
  if (err instanceof LodestarError) {
    return mapValues(err.getMetadata(), (value) => getErrorMetadata(value));
  } else if (err instanceof Error) {
    return err.message;
  } else {
    return err;
  }
}
