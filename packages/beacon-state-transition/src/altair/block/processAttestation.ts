import {allForks, altair, phase0, ssz} from "@chainsafe/lodestar-types";
import {intSqrt} from "@chainsafe/lodestar-utils";

import {computeStartSlotAtEpoch, getBlockRootAtSlot, increaseBalance} from "../../util";
import {CachedBeaconState} from "../../allForks/util";
import {isValidIndexedAttestation} from "../../allForks/block";
import {IParticipationStatus} from "../../allForks/util/cachedEpochParticipation";
import {
  EFFECTIVE_BALANCE_INCREMENT,
  MIN_ATTESTATION_INCLUSION_DELAY,
  PROPOSER_WEIGHT,
  SLOTS_PER_EPOCH,
  TIMELY_HEAD_WEIGHT,
  TIMELY_SOURCE_WEIGHT,
  TIMELY_TARGET_WEIGHT,
  WEIGHT_DENOMINATOR,
} from "@chainsafe/lodestar-params";
import {validateAttestation} from "../../phase0/block/processAttestation";
import {BlockProcess, getEmptyBlockProcess} from "../../util/blockProcess";

const PROPOSER_REWARD_DOMINATOR = ((WEIGHT_DENOMINATOR - PROPOSER_WEIGHT) * WEIGHT_DENOMINATOR) / PROPOSER_WEIGHT;

export function processAttestation(
  state: CachedBeaconState<altair.BeaconState>,
  attestation: phase0.Attestation,
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignature = true
): void {
  const {epochCtx} = state;
  const data = attestation.data;

  validateAttestation(state as CachedBeaconState<allForks.BeaconState>, attestation);

  let epochParticipation;
  if (data.target.epoch === epochCtx.currentShuffling.epoch) {
    epochParticipation = state.currentEpochParticipation;
  } else {
    epochParticipation = state.previousEpochParticipation;
  }

  // this check is done last because its the most expensive (if signature verification is toggled on)
  if (
    !isValidIndexedAttestation(
      state as CachedBeaconState<allForks.BeaconState>,
      epochCtx.getIndexedAttestation(attestation),
      verifySignature
    )
  ) {
    throw new Error("Attestation is not valid");
  }
  const {timelySource, timelyTarget, timelyHead} = getAttestationParticipationStatus(
    state,
    data,
    state.slot - data.slot,
    blockProcess
  );

  // Retrieve the validator indices from the attestation participation bitfield
  const attestingIndices = epochCtx.getAttestingIndices(data, attestation.aggregationBits);

  // For each participant, update their participation
  // In epoch processing, this participation info is used to calculate balance updates
  let totalBalancesWithWeight = BigInt(0);
  for (const index of attestingIndices) {
    const status = epochParticipation.getStatus(index) as IParticipationStatus;
    const newStatus = {
      timelySource: status.timelySource || timelySource,
      timelyTarget: status.timelyTarget || timelyTarget,
      timelyHead: status.timelyHead || timelyHead,
    };
    epochParticipation.setStatus(index, newStatus);
    /**
     * Spec:
     * baseReward = state.validators[index].effectiveBalance / EFFECTIVE_BALANCE_INCREMENT * baseRewardPerIncrement;
     * proposerRewardNumerator += baseReward * totalWeight
     */
    const totalWeight =
      BigInt(!status.timelySource && timelySource) * TIMELY_SOURCE_WEIGHT +
      BigInt(!status.timelyTarget && timelyTarget) * TIMELY_TARGET_WEIGHT +
      BigInt(!status.timelyHead && timelyHead) * TIMELY_HEAD_WEIGHT;
    if (totalWeight > 0) {
      totalBalancesWithWeight += state.validators[index].effectiveBalance * totalWeight;
    }
  }

  const totalIncrements = totalBalancesWithWeight / EFFECTIVE_BALANCE_INCREMENT;
  const proposerRewardNumerator = totalIncrements * state.baseRewardPerIncrement;
  const proposerReward = proposerRewardNumerator / PROPOSER_REWARD_DOMINATOR;
  const proposerIndex = epochCtx.getBeaconProposer(state.slot);
  // we increase proposer reward multiple times per block process, it's better to do that in batch
  if (blockProcess.increaseBalanceCache) {
    let increaseBalanceValue = blockProcess.increaseBalanceCache.get(proposerIndex);
    if (increaseBalanceValue === undefined) {
      increaseBalanceValue = BigInt(0);
    }
    increaseBalanceValue += proposerReward;
    blockProcess.increaseBalanceCache.set(proposerIndex, increaseBalanceValue);
  } else {
    // for spec test only
    increaseBalance(state, proposerIndex, proposerReward);
  }
}

/**
 * https://github.com/ethereum/eth2.0-specs/blob/v1.1.0-alpha.4/specs/altair/beacon-chain.md#get_attestation_participation_flag_indices
 */
export function getAttestationParticipationStatus(
  state: CachedBeaconState<altair.BeaconState>,
  data: phase0.AttestationData,
  inclusionDelay: number,
  blockProcess: BlockProcess = getEmptyBlockProcess()
): IParticipationStatus {
  const {epochCtx} = state;
  let justifiedCheckpoint;
  if (data.target.epoch === epochCtx.currentShuffling.epoch) {
    justifiedCheckpoint = state.currentJustifiedCheckpoint;
  } else {
    justifiedCheckpoint = state.previousJustifiedCheckpoint;
  }
  // The source and target votes are part of the FFG vote, the head vote is part of the fork choice vote
  // Both are tracked to properly incentivise validators
  //
  // The source vote always matches the justified checkpoint (else its invalid)
  // The target vote should match the most recent checkpoint (eg: the first root of the epoch)
  // The head vote should match the root at the attestation slot (eg: the root at data.slot)
  const isMatchingSource = ssz.phase0.Checkpoint.equals(data.source, justifiedCheckpoint);
  if (!isMatchingSource) {
    throw new Error(
      "Attestation source does not equal justified checkpoint: " +
        `source=${JSON.stringify(ssz.phase0.Checkpoint.toJson(data.source))} ` +
        `justifiedCheckpoint=${JSON.stringify(ssz.phase0.Checkpoint.toJson(justifiedCheckpoint))}`
    );
  }
  const {blockRootCache} = blockProcess;
  const targetSlot = computeStartSlotAtEpoch(data.target.epoch);
  let actualTargetBlockRoot = blockRootCache.get(targetSlot);
  if (!actualTargetBlockRoot) {
    actualTargetBlockRoot = getBlockRootAtSlot(state, targetSlot);
    if (!actualTargetBlockRoot) {
      throw new Error("Not block root at target slot " + targetSlot);
    }
    blockRootCache.set(targetSlot, actualTargetBlockRoot);
  }
  const isMatchingTarget = ssz.Root.equals(data.target.root, actualTargetBlockRoot);
  const {beaconBlockRoot, slot} = data;
  let actualBlockRoot = blockRootCache.get(slot);
  if (!actualBlockRoot) {
    actualBlockRoot = getBlockRootAtSlot(state, slot);
    if (!actualBlockRoot) {
      throw new Error("Not block root at slot " + slot);
    }
    blockRootCache.set(slot, actualBlockRoot);
  }
  // a timely head is only be set if the target is _also_ matching
  const isMatchingHead = isMatchingTarget && ssz.Root.equals(beaconBlockRoot, actualBlockRoot);
  return {
    timelySource: isMatchingSource && inclusionDelay <= intSqrt(SLOTS_PER_EPOCH),
    timelyTarget: isMatchingTarget && inclusionDelay <= SLOTS_PER_EPOCH,
    timelyHead: isMatchingHead && inclusionDelay === MIN_ATTESTATION_INCLUSION_DELAY,
  };
}
