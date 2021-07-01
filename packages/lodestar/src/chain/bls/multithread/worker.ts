import worker from "worker_threads";
import {expose} from "threads/worker";
import {bls, init, CoordType} from "@chainsafe/bls";
import {verifySignatureSetsMaybeBatch, SignatureSetDeserialized} from "../maybeBatch";
import {WorkerData, BlsWorkReq, WorkResult, WorkResultCode, SerializedSet, BlsWorkResult} from "./types";

/* eslint-disable no-console */

// Cloned data from instatiation
const workerData = worker.workerData as WorkerData;
if (!workerData) throw Error("workerData must be defined");
const {implementation, workerId} = workerData || {};

expose({
  async doManyBlsWorkReq(workReqArr: BlsWorkReq[]): Promise<BlsWorkResult> {
    await init(implementation);
    return doManyBlsWorkReq(workReqArr);
  },
});

function doManyBlsWorkReq(workReqArr: BlsWorkReq[]): BlsWorkResult {
  const startNs = process.hrtime.bigint();
  const results: WorkResult<boolean>[] = [];
  let batchRetries = 0;
  let batchSigsSuccess = 0;

  // If there are multiple batchable sets attempt batch verification with them
  const batchable: {idx: number; workReq: BlsWorkReq}[] = [];
  const nonBatchable: {idx: number; workReq: BlsWorkReq}[] = [];

  // TODO: Split batchable into chunks of max size ~ 32 to minimize cost if a sig is wrong

  for (let i = 0; i < workReqArr.length; i++) {
    const workReq = workReqArr[i];
    if (workReq.opts.batchable) {
      batchable.push({idx: i, workReq});
    } else {
      nonBatchable.push({idx: i, workReq});
    }
  }

  if (batchable.length > 0) {
    const allSets: SignatureSetDeserialized[] = [];
    for (const {workReq} of batchable) {
      for (const set of workReq.sets) {
        allSets.push(deserializeSet(set));
      }
    }

    try {
      const isValid = verifySignatureSetsMaybeBatch(allSets);

      if (isValid) {
        // The entire batch is valid
        for (const {idx, workReq} of batchable) {
          batchSigsSuccess += workReq.sets.length;
          results[idx] = {code: WorkResultCode.success, result: isValid};
        }
      } else {
        batchRetries++;
        // Re-verify all sigs
        nonBatchable.push(...batchable);
      }
    } catch (e) {
      // Return error to the main thread so it can be visible
      for (const {idx} of batchable) {
        results[idx] = {code: WorkResultCode.error, error: e as Error};
      }
    }
  }

  for (const {idx, workReq} of nonBatchable) {
    try {
      const isValid = verifySignatureSetsMaybeBatch(workReq.sets.map(deserializeSet));
      results[idx] = {code: WorkResultCode.success, result: isValid};
    } catch (e) {
      results[idx] = {code: WorkResultCode.error, error: e as Error};
    }
  }

  return {
    workerId,
    batchRetries,
    batchSigsSuccess,
    workerStartNs: startNs,
    workerEndNs: process.hrtime.bigint(),
    results,
  };
}

function deserializeSet(set: SerializedSet): SignatureSetDeserialized {
  return {
    publicKey: bls.PublicKey.fromBytes(set.publicKey, CoordType.affine),
    message: set.message,
    signature: set.signature,
  };
}
