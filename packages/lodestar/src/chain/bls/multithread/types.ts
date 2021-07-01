import {VerifySignatureOpts} from "../interface";

export type WorkerData = {
  implementation: "herumi" | "blst-native";
  workerId: number;
};

export type SerializedSet = {
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
};

export type BlsWorkReq = {
  opts: VerifySignatureOpts;
  sets: SerializedSet[];
};

export enum WorkResultCode {
  success = "success",
  error = "error",
}

export type WorkResult<R> = {code: WorkResultCode.success; result: R} | {code: WorkResultCode.error; error: Error};

export type BlsWorkResult = {
  workerId: number;
  batchRetries: number;
  batchSigsSuccess: number;
  workerStartNs: bigint;
  workerEndNs: bigint;
  results: WorkResult<boolean>[];
};
