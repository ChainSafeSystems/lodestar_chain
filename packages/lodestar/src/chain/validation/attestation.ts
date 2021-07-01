import {Epoch, Root, Slot, ssz} from "@chainsafe/lodestar-types";
import {IBlockSummary} from "@chainsafe/lodestar-fork-choice";
import {SLOTS_PER_EPOCH} from "@chainsafe/lodestar-params";
import {List} from "@chainsafe/ssz";
import {
  allForks,
  phase0,
  computeEpochAtSlot,
  getSingleBitIndex,
  AggregationBitsError,
  AggregationBitsErrorCode,
} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconChain} from "..";
import {AttestationError, AttestationErrorCode, GossipAction} from "../errors";
import {MAXIMUM_GOSSIP_CLOCK_DISPARITY_SEC} from "../../constants";

const {EpochContextError, EpochContextErrorCode, computeSubnetForSlot, getIndexedAttestationSignatureSet} = allForks;

export async function validateGossipAttestation(
  chain: IBeaconChain,
  attestation: phase0.Attestation,
  /** Optional, to allow verifying attestations through API with unknown subnet */
  subnet: number | null
): Promise<{indexedAttestation: phase0.IndexedAttestation; subnet: number}> {
  // Do checks in this order:
  // - do early checks (w/o indexed attestation)
  // - > obtain indexed attestation and committes per slot
  // - do middle checks w/ indexed attestation
  // - > verify signature
  // - do late checks w/ a valid signature

  // verify_early_checks
  // Run the checks that happen before an indexed attestation is constructed.
  const attData = attestation.data;
  const attSlot = attData.slot;
  const attEpoch = computeEpochAtSlot(attSlot);
  const attTarget = attData.target;
  const targetEpoch = attTarget.epoch;

  // [REJECT] The attestation's epoch matches its target -- i.e. attestation.data.target.epoch == compute_epoch_at_slot(attestation.data.slot)
  if (!ssz.Epoch.equals(targetEpoch, attEpoch)) {
    throw new AttestationError(GossipAction.REJECT, {
      code: AttestationErrorCode.BAD_TARGET_EPOCH,
    });
  }

  // [IGNORE] attestation.data.slot is within the last ATTESTATION_PROPAGATION_SLOT_RANGE slots (within a MAXIMUM_GOSSIP_CLOCK_DISPARITY allowance)
  //  -- i.e. attestation.data.slot + ATTESTATION_PROPAGATION_SLOT_RANGE >= current_slot >= attestation.data.slot
  // (a client MAY queue future attestations for processing at the appropriate slot).
  verifyPropagationSlotRange(chain, attSlot);

  // [REJECT] The attestation is unaggregated -- that is, it has exactly one participating validator
  // (len([bit for bit in attestation.aggregation_bits if bit]) == 1, i.e. exactly 1 bit is set).
  // > TODO: Do this check **before** getting the target state but don't recompute zipIndexes
  const aggregationBits = attestation.aggregationBits;
  let bitIndex: number;
  try {
    bitIndex = getSingleBitIndex(aggregationBits);
  } catch (e) {
    if (e instanceof AggregationBitsError && e.type.code === AggregationBitsErrorCode.NOT_EXACTLY_ONE_BIT_SET) {
      throw new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.NOT_EXACTLY_ONE_AGGREGATION_BIT_SET});
    } else {
      throw e;
    }
  }

  // Attestations must be for a known block. If the block is unknown, we simply drop the
  // attestation and do not delay consideration for later.
  //
  // TODO (LH): Enforce a maximum skip distance for unaggregated attestations.

  // [IGNORE] The block being voted for (attestation.data.beacon_block_root) has been seen (via both gossip
  // and non-gossip sources) (a client MAY queue attestations for processing once block is retrieved).
  verifyHeadBlockAndTargetRoot(chain, attData.beaconBlockRoot, attTarget.root, attEpoch);

  // [REJECT] The block being voted for (attestation.data.beacon_block_root) passes validation.
  // > Altready check in `verifyHeadBlockAndTargetRoot()`

  // [REJECT] The current finalized_checkpoint is an ancestor of the block defined by attestation.data.beacon_block_root
  // -- i.e. get_ancestor(store, attestation.data.beacon_block_root, compute_start_slot_at_epoch(store.finalized_checkpoint.epoch)) == store.finalized_checkpoint.root
  // > Altready check in `verifyHeadBlockAndTargetRoot()`

  // [REJECT] The attestation's target block is an ancestor of the block named in the LMD vote
  //  --i.e. get_ancestor(store, attestation.data.beacon_block_root, compute_start_slot_at_epoch(attestation.data.target.epoch)) == attestation.data.target.root
  // > Altready check in `verifyHeadBlockAndTargetRoot()`

  const attestationTargetState = await chain.regen.getCheckpointState(attTarget).catch((e) => {
    throw new AttestationError(GossipAction.REJECT, {
      code: AttestationErrorCode.MISSING_ATTESTATION_TARGET_STATE,
      error: e as Error,
    });
  });

  // [REJECT] The committee index is within the expected range
  // -- i.e. data.index < get_committee_count_per_slot(state, data.target.epoch)
  const attIndex = attData.index;
  const committeeIndices = getCommitteeIndices(attestationTargetState, attSlot, attIndex);
  const validatorIndex = committeeIndices[bitIndex];

  // [REJECT] The number of aggregation bits matches the committee size
  // -- i.e. len(attestation.aggregation_bits) == len(get_beacon_committee(state, data.slot, data.index)).
  // > TODO: Is this necessary? Lighthouse does not do this check
  if (aggregationBits.length !== committeeIndices.length) {
    throw new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.WRONG_NUMBER_OF_AGGREGATION_BITS});
  }

  // LH > verify_middle_checks
  // Run the checks that apply to the indexed attestation before the signature is checked.
  //   Check correct subnet
  //   The attestation is the first valid attestation received for the participating validator for the slot, attestation.data.slot.

  // [REJECT] The attestation is for the correct subnet
  // -- i.e. compute_subnet_for_attestation(committees_per_slot, attestation.data.slot, attestation.data.index) == subnet_id,
  // where committees_per_slot = get_committee_count_per_slot(state, attestation.data.target.epoch),
  // which may be pre-computed along with the committee information for the signature check.
  const expectedSubnet = computeSubnetForSlot(attestationTargetState, attSlot, attIndex);
  if (subnet !== null && subnet !== expectedSubnet) {
    throw new AttestationError(GossipAction.REJECT, {
      code: AttestationErrorCode.INVALID_SUBNET_ID,
      received: subnet,
      expected: expectedSubnet,
    });
  }

  // [IGNORE] There has been no other valid attestation seen on an attestation subnet that has an
  // identical attestation.data.target.epoch and participating validator index.
  if (chain.seenAttesters.isKnown(targetEpoch, validatorIndex)) {
    throw new AttestationError(GossipAction.IGNORE, {
      code: AttestationErrorCode.ATTESTATION_ALREADY_KNOWN,
      targetEpoch,
      validatorIndex,
    });
  }

  // [REJECT] The signature of attestation is valid.
  const indexedAttestation: phase0.IndexedAttestation = {
    attestingIndices: [validatorIndex] as List<number>,
    data: attData,
    signature: attestation.signature,
  };
  const signatureSet = getIndexedAttestationSignatureSet(attestationTargetState, indexedAttestation);
  if (!(await chain.bls.verifySignatureSets([signatureSet], {batchable: true}))) {
    throw new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.INVALID_SIGNATURE});
  }

  // Now that the attestation has been fully verified, store that we have received a valid attestation from this validator.
  //
  // It's important to double check that the attestation still hasn't been observed, since
  // there can be a race-condition if we receive two attestations at the same time and
  // process them in different threads.
  if (chain.seenAttesters.isKnown(targetEpoch, validatorIndex)) {
    throw new AttestationError(GossipAction.IGNORE, {
      code: AttestationErrorCode.ATTESTATION_ALREADY_KNOWN,
      targetEpoch,
      validatorIndex,
    });
  }

  chain.seenAttesters.add(targetEpoch, validatorIndex);

  return {indexedAttestation, subnet: expectedSubnet};
}

/**
 * Verify that the `attestation` is within the acceptable gossip propagation range, with reference
 * to the current slot of the `chain`.
 *
 * Accounts for `MAXIMUM_GOSSIP_CLOCK_DISPARITY`.
 * Note: We do not queue future attestations for later processing
 */
export function verifyPropagationSlotRange(chain: IBeaconChain, attestationSlot: Slot): void {
  // slot with future tolerance of MAXIMUM_GOSSIP_CLOCK_DISPARITY_SEC
  const latestPermissibleSlot = chain.clock.slotWithTolerance(MAXIMUM_GOSSIP_CLOCK_DISPARITY_SEC);
  const earliestPermissibleSlot = Math.max(
    // slot with past tolerance of MAXIMUM_GOSSIP_CLOCK_DISPARITY_SEC
    // ATTESTATION_PROPAGATION_SLOT_RANGE = SLOTS_PER_EPOCH
    chain.clock.slotWithTolerance(-MAXIMUM_GOSSIP_CLOCK_DISPARITY_SEC) - SLOTS_PER_EPOCH,
    0
  );
  if (attestationSlot < earliestPermissibleSlot) {
    throw new AttestationError(GossipAction.IGNORE, {
      code: AttestationErrorCode.PAST_SLOT,
      earliestPermissibleSlot,
      attestationSlot,
    });
  }
  if (attestationSlot > latestPermissibleSlot) {
    throw new AttestationError(GossipAction.IGNORE, {
      code: AttestationErrorCode.FUTURE_SLOT,
      latestPermissibleSlot,
      attestationSlot,
    });
  }
}

/**
 * Verify:
 * 1. head block is known
 * 2. attestation's target block is an ancestor of the block named in the LMD vote
 */
export function verifyHeadBlockAndTargetRoot(
  chain: IBeaconChain,
  beaconBlockRoot: Root,
  targetRoot: Root,
  attestationEpoch: Epoch
): void {
  const headBlock = verifyHeadBlockIsKnown(chain, beaconBlockRoot);
  verifyAttestationTargetRoot(headBlock, targetRoot, attestationEpoch);
}

/**
 * Checks if the `attestation.data.beaconBlockRoot` is known to this chain.
 *
 * The block root may not be known for two reasons:
 *
 * 1. The block has never been verified by our application.
 * 2. The block is prior to the latest finalized block.
 *
 * Case (1) is the exact thing we're trying to detect. However case (2) is a little different, but
 * it's still fine to reject here because there's no need for us to handle attestations that are
 * already finalized.
 */
function verifyHeadBlockIsKnown(chain: IBeaconChain, beaconBlockRoot: Root): IBlockSummary {
  // TODO (LH): Enforce a maximum skip distance for unaggregated attestations.

  const headBlock = chain.forkChoice.getBlock(beaconBlockRoot);
  if (headBlock === null) {
    throw new AttestationError(GossipAction.IGNORE, {
      code: AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT,
      root: beaconBlockRoot.valueOf() as Uint8Array,
    });
  }

  return headBlock;
}

/**
 * Verifies that the `attestation.data.target.root` is indeed the target root of the block at
 * `attestation.data.beacon_block_root`.
 */
function verifyAttestationTargetRoot(headBlock: IBlockSummary, targetRoot: Root, attestationEpoch: Epoch): void {
  // Check the attestation target root.
  const headBlockEpoch = computeEpochAtSlot(headBlock.slot);

  if (headBlockEpoch > attestationEpoch) {
    // The epoch references an invalid head block from a future epoch.
    //
    // This check is not in the specification, however we guard against it since it opens us up
    // to weird edge cases during verification.
    //
    // Whilst this attestation *technically* could be used to add value to a block, it is
    // invalid in the spirit of the protocol. Here we choose safety over profit.
    //
    // Reference:
    // https://github.com/ethereum/eth2.0-specs/pull/2001#issuecomment-699246659
    throw new AttestationError(GossipAction.REJECT, {
      code: AttestationErrorCode.INVALID_TARGET_ROOT,
      targetRoot: targetRoot.valueOf() as Uint8Array,
      expected: null,
    });
  } else {
    const expectedTargetRoot =
      headBlockEpoch === attestationEpoch
        ? // If the block is in the same epoch as the attestation, then use the target root
          // from the block.
          headBlock.targetRoot
        : // If the head block is from a previous epoch then skip slots will cause the head block
          // root to become the target block root.
          //
          // We know the head block is from a previous epoch due to a previous check.
          headBlock.blockRoot;

    if (!ssz.Root.equals(expectedTargetRoot, targetRoot)) {
      // Reject any attestation with an invalid target root.
      throw new AttestationError(GossipAction.REJECT, {
        code: AttestationErrorCode.INVALID_TARGET_ROOT,
        targetRoot: targetRoot.valueOf() as Uint8Array,
        expected: expectedTargetRoot,
      });
    }
  }
}

export function getCommitteeIndices(
  attestationTargetState: allForks.CachedBeaconState<allForks.BeaconState>,
  attestationSlot: Slot,
  attestationIndex: number
): number[] {
  try {
    return attestationTargetState.getBeaconCommittee(attestationSlot, attestationIndex);
  } catch (e) {
    if (e instanceof EpochContextError && e.type.code === EpochContextErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE) {
      throw new AttestationError(GossipAction.REJECT, {
        code: AttestationErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE,
        index: attestationIndex,
      });
    } else {
      throw e;
    }
  }
}
