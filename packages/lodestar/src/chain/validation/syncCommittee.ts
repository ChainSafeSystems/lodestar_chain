import {CachedBeaconState, computeSyncPeriodAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {SYNC_COMMITTEE_SIZE, SYNC_COMMITTEE_SUBNET_COUNT} from "@chainsafe/lodestar-params";
import {allForks, altair} from "@chainsafe/lodestar-types";
import {GossipAction, SyncCommitteeError, SyncCommitteeErrorCode} from "../errors";
import {IBeaconChain} from "../interface";
import {getSyncCommitteeSignatureSet} from "./signatureSets";

type IndexInSubCommittee = number;

/**
 * Spec v1.1.0-alpha.5
 */
export async function validateGossipSyncCommittee(
  chain: IBeaconChain,
  syncCommittee: altair.SyncCommitteeMessage,
  subnet: number
): Promise<{indexInSubCommittee: IndexInSubCommittee}> {
  const {slot, validatorIndex} = syncCommittee;

  const headState = chain.getHeadState();
  const indexInSubCommittee = validateGossipSyncCommitteeExceptSig(chain, headState, subnet, syncCommittee);

  // [IGNORE] The signature's slot is for the current slot, i.e. sync_committee_signature.slot == current_slot.
  // > Checked in validateGossipSyncCommitteeExceptSig()

  // [IGNORE] The block being signed over (sync_committee_signature.beacon_block_root) has been seen (via both gossip and non-gossip sources).
  // > Checked in validateGossipSyncCommitteeExceptSig()

  // [IGNORE] There has been no other valid sync committee signature for the declared slot for the validator referenced
  // by sync_committee_signature.validator_index.
  if (chain.seenSyncCommitteeMessages.isKnown(slot, subnet, validatorIndex)) {
    throw new SyncCommitteeError(GossipAction.IGNORE, {
      code: SyncCommitteeErrorCode.SYNC_COMMITTEE_ALREADY_KNOWN,
    });
  }

  // [REJECT] The subnet_id is valid for the given validator, i.e. subnet_id in compute_subnets_for_sync_committee(state, sync_committee_signature.validator_index).
  // Note this validation implies the validator is part of the broader current sync committee along with the correct subcommittee.
  // > Checked in validateGossipSyncCommitteeExceptSig()

  // [REJECT] The signature is valid for the message beacon_block_root for the validator referenced by validator_index.
  await validateSyncCommitteeSigOnly(chain, headState, syncCommittee);

  // Register this valid item as seen
  chain.seenSyncCommitteeMessages.add(slot, subnet, validatorIndex);

  return {indexInSubCommittee};
}

/**
 * Abstracted so it can be re-used in API validation.
 */
export async function validateSyncCommitteeSigOnly(
  chain: IBeaconChain,
  headState: CachedBeaconState<allForks.BeaconState>,
  syncCommittee: altair.SyncCommitteeMessage
): Promise<void> {
  const signatureSet = getSyncCommitteeSignatureSet(headState, syncCommittee);
  if (!(await chain.bls.verifySignatureSets([signatureSet], {batchable: true}))) {
    throw new SyncCommitteeError(GossipAction.REJECT, {
      code: SyncCommitteeErrorCode.INVALID_SIGNATURE,
    });
  }
}

/**
 * Spec v1.1.0-alpha.3
 */
export function validateGossipSyncCommitteeExceptSig(
  chain: IBeaconChain,
  headState: CachedBeaconState<allForks.BeaconState>,
  subnet: number,
  data: Pick<altair.SyncCommitteeMessage, "slot" | "beaconBlockRoot" | "validatorIndex">
): IndexInSubCommittee {
  const {slot, beaconBlockRoot, validatorIndex} = data;
  // [IGNORE] The signature's slot is for the current slot, i.e. sync_committee_signature.slot == current_slot.
  // (with a MAXIMUM_GOSSIP_CLOCK_DISPARITY allowance)
  if (!chain.clock.isCurrentSlotGivenGossipDisparity(slot)) {
    throw new SyncCommitteeError(GossipAction.IGNORE, {
      code: SyncCommitteeErrorCode.NOT_CURRENT_SLOT,
      currentSlot: chain.clock.currentSlot,
      slot,
    });
  }

  // [IGNORE] The block being signed over (sync_committee_signature.beacon_block_root) has been seen (via both gossip and non-gossip sources).
  if (!chain.forkChoice.hasBlock(beaconBlockRoot)) {
    throw new SyncCommitteeError(GossipAction.IGNORE, {
      code: SyncCommitteeErrorCode.UNKNOWN_BEACON_BLOCK_ROOT,
      beaconBlockRoot: beaconBlockRoot as Uint8Array,
    });
  }

  // [REJECT] The subcommittee index is in the allowed range, i.e. contribution.subcommittee_index < SYNC_COMMITTEE_SUBNET_COUNT.
  if (subnet >= SYNC_COMMITTEE_SUBNET_COUNT) {
    throw new SyncCommitteeError(GossipAction.REJECT, {
      code: SyncCommitteeErrorCode.INVALID_SUB_COMMITTEE_INDEX,
      subCommitteeIndex: subnet,
    });
  }

  // [REJECT] The subnet_id is valid for the given validator, i.e. subnet_id in compute_subnets_for_sync_committee(state, sync_committee_signature.validator_index).
  // Note this validation implies the validator is part of the broader current sync committee along with the correct subcommittee.
  const indexInSubCommittee = getIndexInSubCommittee(headState, subnet, data);
  if (indexInSubCommittee === null) {
    throw new SyncCommitteeError(GossipAction.REJECT, {
      code: SyncCommitteeErrorCode.VALIDATOR_NOT_IN_SYNC_COMMITTEE,
      validatorIndex,
    });
  }

  return indexInSubCommittee;
}

/**
 * Returns the IndexInSubCommittee of the given `subnet`.
 * Returns `null` if not part of the sync committee or not part of the given `subnet`
 */
function getIndexInSubCommittee(
  headState: CachedBeaconState<allForks.BeaconState>,
  subnet: number,
  data: Pick<altair.SyncCommitteeMessage, "slot" | "validatorIndex">
): IndexInSubCommittee | null {
  // Note: The range of slots a validator has to perform duties is off by one.
  // The previous slot wording means that if your validator is in a sync committee for a period that runs from slot
  // 100 to 200,then you would actually produce signatures in slot 99 - 199.
  const statePeriod = computeSyncPeriodAtSlot(headState.slot);
  const dataPeriod = computeSyncPeriodAtSlot(data.slot + 1); // See note above for the +1 offset

  const syncComitteeValidatorIndexMap =
    dataPeriod === statePeriod + 1
      ? headState.nextSyncCommittee.validatorIndexMap
      : headState.currentSyncCommittee.validatorIndexMap;

  const indexesInCommittee = syncComitteeValidatorIndexMap?.get(data.validatorIndex);
  if (indexesInCommittee === undefined) {
    // Not part of the sync committee
    return null;
  }

  // TODO: Cache this value
  const SYNC_COMMITTEE_SUBNET_SIZE = Math.floor(SYNC_COMMITTEE_SIZE / SYNC_COMMITTEE_SUBNET_COUNT);

  for (const indexInCommittee of indexesInCommittee) {
    if (Math.floor(indexInCommittee / SYNC_COMMITTEE_SUBNET_SIZE) === subnet) {
      return indexInCommittee % SYNC_COMMITTEE_SUBNET_SIZE;
    }
  }

  // Not part of this specific subnet
  return null;
}
