import {allForks, altair} from "@chainsafe/lodestar-types";

import {CachedBeaconState} from "../../allForks/util";
import {processBlockHeader, processEth1Data, processRandao} from "../../allForks/block";
import {processOperations} from "./processOperations";
import {processAttestation} from "./processAttestation";
import {processAttesterSlashing} from "./processAttesterSlashing";
import {processDeposit} from "./processDeposit";
import {processProposerSlashing} from "./processProposerSlashing";
import {processVoluntaryExit} from "./processVoluntaryExit";
import {processSyncAggregate} from "./processSyncCommittee";
import {getEmptyBlockProcess, increaseBalance} from "../../util";

export {
  processOperations,
  processAttestation,
  processAttesterSlashing,
  processDeposit,
  processProposerSlashing,
  processVoluntaryExit,
  processSyncAggregate,
};

export function processBlock(
  state: CachedBeaconState<altair.BeaconState>,
  block: altair.BeaconBlock,
  verifySignatures = true
): void {
  const blockProcess = getEmptyBlockProcess();
  // increasing balance on the same validator index multiple times per epoch transition is not efficient
  blockProcess.increaseBalanceCache = new Map();
  processBlockHeader(state as CachedBeaconState<allForks.BeaconState>, block);
  processRandao(state as CachedBeaconState<allForks.BeaconState>, block, verifySignatures);
  processEth1Data(state as CachedBeaconState<allForks.BeaconState>, block.body);
  processOperations(state, block.body, blockProcess, verifySignatures);
  processSyncAggregate(state, block, blockProcess, verifySignatures);
  for (const [validatorIndex, increaseBalanceValue] of blockProcess.increaseBalanceCache.entries()) {
    increaseBalance(state, validatorIndex, increaseBalanceValue);
  }
}
