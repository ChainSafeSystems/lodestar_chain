import {allForks, altair, phase0} from "@chainsafe/lodestar-types";
import {ForkName} from "@chainsafe/lodestar-params";
import {CachedBeaconState} from "../../allForks/util";
import {processAttesterSlashing as processAttesterSlashingAllForks} from "../../allForks/block";
import {BlockProcess, getEmptyBlockProcess} from "../../util/blockProcess";

export function processAttesterSlashing(
  state: CachedBeaconState<altair.BeaconState>,
  attesterSlashing: phase0.AttesterSlashing,
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignatures = true
): void {
  processAttesterSlashingAllForks(
    ForkName.altair,
    state as CachedBeaconState<allForks.BeaconState>,
    attesterSlashing,
    blockProcess,
    verifySignatures
  );
}
