import {allForks, phase0} from "@chainsafe/lodestar-types";
import {CachedBeaconState} from "../../allForks/util";
import {processVoluntaryExit as processVoluntaryExitAllForks} from "../../allForks/block";
import {BlockProcess, getEmptyBlockProcess} from "../../util/blockProcess";

export function processVoluntaryExit(
  state: CachedBeaconState<phase0.BeaconState>,
  signedVoluntaryExit: phase0.SignedVoluntaryExit,
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignature = true
): void {
  processVoluntaryExitAllForks(
    state as CachedBeaconState<allForks.BeaconState>,
    signedVoluntaryExit,
    blockProcess,
    verifySignature
  );
}
