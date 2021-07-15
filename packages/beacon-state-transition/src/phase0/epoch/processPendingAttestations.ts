import {allForks, Epoch, phase0, ssz} from "@chainsafe/lodestar-types";
import {List, readonlyValues} from "@chainsafe/ssz";
import {CachedBeaconState, IAttesterStatus} from "../../allForks/util";
import {computeStartSlotAtEpoch, getBlockRootAtSlot, zipIndexesCommitteeBits} from "../../util";

export function statusProcessEpoch<T extends allForks.BeaconState>(
  state: CachedBeaconState<T>,
  statuses: IAttesterStatus[],
  attestations: List<phase0.PendingAttestation>,
  epoch: Epoch,
  sourceFlag: number,
  targetFlag: number,
  headFlag: number
): void {
  const {epochCtx} = state;
  const rootType = ssz.Root;
  const prevEpoch = epochCtx.previousShuffling.epoch;
  const actualTargetBlockRoot = getBlockRootAtSlot(state, computeStartSlotAtEpoch(epoch));
  const blockRoots = new Map<phase0.Slot, phase0.Root>();
  for (const att of readonlyValues(attestations)) {
    const aggregationBits = att.aggregationBits;
    const attData = att.data;
    const inclusionDelay = att.inclusionDelay;
    const proposerIndex = att.proposerIndex;
    const attSlot = attData.slot;
    const committeeIndex = attData.index;
    const attBeaconBlockRoot = attData.beaconBlockRoot;
    const attTarget = attData.target;
    const attVotedTargetRoot = rootType.equals(attTarget.root, actualTargetBlockRoot);
    let actualHeadRoot = blockRoots.get(attSlot);
    if (!actualHeadRoot) {
      actualHeadRoot = getBlockRootAtSlot(state, attSlot);
      blockRoots.set(attSlot, actualHeadRoot);
    }
    const attVotedHeadRoot = rootType.equals(attBeaconBlockRoot, actualHeadRoot);
    const committee = epochCtx.getBeaconCommittee(attSlot, committeeIndex);
    const participants = zipIndexesCommitteeBits(committee, aggregationBits);

    if (epoch === prevEpoch) {
      for (const p of participants) {
        const status = statuses[p];
        if (status.proposerIndex === -1 || status.inclusionDelay > inclusionDelay) {
          status.proposerIndex = proposerIndex;
          status.inclusionDelay = inclusionDelay;
        }
      }
    }

    for (const p of participants) {
      const status = statuses[p];
      status.flags |= sourceFlag;
      if (attVotedTargetRoot) {
        status.flags |= targetFlag;
        if (attVotedHeadRoot) {
          status.flags |= headFlag;
        }
      }
    }
  }
}
