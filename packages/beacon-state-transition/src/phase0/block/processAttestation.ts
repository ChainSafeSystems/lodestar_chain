import {allForks, phase0, ssz} from "@chainsafe/lodestar-types";

import {computeEpochAtSlot} from "../../util";
import {CachedBeaconState} from "../../allForks/util";
import {isValidIndexedAttestation} from "../../allForks/block";
import {MIN_ATTESTATION_INCLUSION_DELAY, SLOTS_PER_EPOCH} from "@chainsafe/lodestar-params";
import {BlockProcess, getEmptyBlockProcess} from "../../util/blockProcess";

export function processAttestation(
  state: CachedBeaconState<phase0.BeaconState>,
  attestation: phase0.Attestation,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignature = true
): void {
  const {epochCtx} = state;
  const slot = state.slot;
  const data = attestation.data;

  validateAttestation(state as CachedBeaconState<allForks.BeaconState>, attestation);

  const pendingAttestation = ssz.phase0.PendingAttestation.createTreeBackedFromStruct({
    data: data,
    aggregationBits: attestation.aggregationBits,
    inclusionDelay: slot - data.slot,
    proposerIndex: epochCtx.getBeaconProposer(slot),
  });

  if (data.target.epoch === epochCtx.currentShuffling.epoch) {
    if (!ssz.phase0.Checkpoint.equals(data.source, state.currentJustifiedCheckpoint)) {
      throw new Error(
        "Attestation source does not equal current justified checkpoint: " +
          `source=${ssz.phase0.Checkpoint.toJson(data.source)} ` +
          `currentJustifiedCheckpoint=${ssz.phase0.Checkpoint.toJson(state.currentJustifiedCheckpoint)}`
      );
    }
    state.currentEpochAttestations.push(pendingAttestation);
  } else {
    if (!ssz.phase0.Checkpoint.equals(data.source, state.previousJustifiedCheckpoint)) {
      throw new Error(
        "Attestation source does not equal previous justified checkpoint: " +
          `source=${ssz.phase0.Checkpoint.toJson(data.source)} ` +
          `previousJustifiedCheckpoint=${ssz.phase0.Checkpoint.toJson(state.previousJustifiedCheckpoint)}`
      );
    }
    state.previousEpochAttestations.push(pendingAttestation);
  }

  if (
    !isValidIndexedAttestation(
      state as CachedBeaconState<allForks.BeaconState>,
      epochCtx.getIndexedAttestation(attestation),
      verifySignature
    )
  ) {
    throw new Error("Attestation is not valid");
  }
}

export function validateAttestation(
  state: CachedBeaconState<allForks.BeaconState>,
  attestation: phase0.Attestation
): void {
  const {epochCtx} = state;
  const slot = state.slot;
  const data = attestation.data;
  const computedEpoch = computeEpochAtSlot(data.slot);
  const committeeCount = epochCtx.getCommitteeCountPerSlot(computedEpoch);
  if (!(data.index < committeeCount)) {
    throw new Error(
      "Attestation committee index not within current committee count: " +
        `committeeIndex=${data.index} committeeCount=${committeeCount}`
    );
  }
  if (
    !(data.target.epoch === epochCtx.previousShuffling.epoch || data.target.epoch === epochCtx.currentShuffling.epoch)
  ) {
    throw new Error(
      "Attestation target epoch not in previous or current epoch: " +
        `targetEpoch=${data.target.epoch} currentEpoch=${epochCtx.currentShuffling.epoch}`
    );
  }
  if (!(data.target.epoch === computedEpoch)) {
    throw new Error(
      "Attestation target epoch does not match epoch computed from slot: " +
        `targetEpoch=${data.target.epoch} computedEpoch=${computedEpoch}`
    );
  }
  if (!(data.slot + MIN_ATTESTATION_INCLUSION_DELAY <= slot && slot <= data.slot + SLOTS_PER_EPOCH)) {
    throw new Error(
      "Attestation slot not within inclusion window: " +
        `slot=${data.slot} window=${data.slot + MIN_ATTESTATION_INCLUSION_DELAY}..${data.slot + SLOTS_PER_EPOCH}`
    );
  }

  const committee = epochCtx.getBeaconCommittee(data.slot, data.index);
  if (attestation.aggregationBits.length !== committee.length) {
    throw new Error(
      "Attestation aggregation bits length does not match committee length: " +
        `aggregationBitsLength=${attestation.aggregationBits.length} committeeLength=${committee.length}`
    );
  }
}
