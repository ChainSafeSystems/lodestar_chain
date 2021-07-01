import {phase0, allForks} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconChain} from "..";
import {VoluntaryExitError, VoluntaryExitErrorCode, GossipAction} from "../errors";
import {IBeaconDb} from "../../db";

export async function validateGossipVoluntaryExit(
  chain: IBeaconChain,
  db: IBeaconDb,
  voluntaryExit: phase0.SignedVoluntaryExit
): Promise<void> {
  if (await db.voluntaryExit.has(voluntaryExit.message.validatorIndex)) {
    throw new VoluntaryExitError(GossipAction.IGNORE, {
      code: VoluntaryExitErrorCode.ALREADY_EXISTS,
    });
  }

  const state = await chain.regen.getCheckpointState({
    root: chain.forkChoice.getHeadRoot(),
    epoch: voluntaryExit.message.epoch,
  });

  try {
    // verifySignature = false, verified in batch below
    allForks.assertValidVoluntaryExit(state, voluntaryExit, false);
  } catch (e) {
    throw new VoluntaryExitError(GossipAction.REJECT, {
      code: VoluntaryExitErrorCode.INVALID,
      error: e as Error,
    });
  }

  const signatureSet = allForks.getVoluntaryExitSignatureSet(state, voluntaryExit);
  if (!(await chain.bls.verifySignatureSets([signatureSet], {batchable: true}))) {
    throw new VoluntaryExitError(GossipAction.REJECT, {
      code: VoluntaryExitErrorCode.INVALID,
      error: Error("Invalid signature"),
    });
  }
}
