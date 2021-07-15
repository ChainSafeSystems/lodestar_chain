import {allForks, altair, phase0} from "@chainsafe/lodestar-types";
import {ForkName} from "@chainsafe/lodestar-params";
import {CachedBeaconState} from "../../allForks/util";
import {processProposerSlashing as processProposerSlashingAllForks} from "../../allForks/block";
import {BlockProcess, getEmptyBlockProcess} from "../../util/blockProcess";

export function processProposerSlashing(
  state: CachedBeaconState<altair.BeaconState>,
  proposerSlashing: phase0.ProposerSlashing,
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignatures = true
): void {
  processProposerSlashingAllForks(
    ForkName.altair,
    state as CachedBeaconState<allForks.BeaconState>,
    proposerSlashing,
    blockProcess,
    verifySignatures
  );
}
