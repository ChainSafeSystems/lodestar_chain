import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IBeaconDb} from "../../db/api";
import {IAttestationJob, IBeaconChain} from "..";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {phase0} from "@chainsafe/lodestar-beacon-state-transition";
import {AttestationError, AttestationErrorCode} from "../errors";
import {ATTESTATION_PROPAGATION_SLOT_RANGE} from "../../constants";

export async function validateGossipAttestation(
  config: IBeaconConfig,
  chain: IBeaconChain,
  db: IBeaconDb,
  attestationJob: IAttestationJob,
  subnet: number
): Promise<void> {
  const attestation = attestationJob.attestation;
  const numBits = getAttestationAttesterCount(attestation);
  if (numBits !== 1) {
    throw new AttestationError({
      code: AttestationErrorCode.NOT_EXACTLY_ONE_AGGREGATION_BIT_SET,
      numBits,
      job: attestationJob,
    });
  }
  if (await isAttestingToInValidBlock(db, attestation)) {
    throw new AttestationError({
      code: AttestationErrorCode.KNOWN_BAD_BLOCK,
      job: attestationJob,
    });
  }
  const latestPermissibleSlot = chain.clock.currentSlot;
  const earliestPermissibleSlot = chain.clock.currentSlot - ATTESTATION_PROPAGATION_SLOT_RANGE;
  const attestationSlot = attestation.data.slot;
  if (attestationSlot < earliestPermissibleSlot) {
    throw new AttestationError({
      code: AttestationErrorCode.PAST_SLOT,
      earliestPermissibleSlot,
      attestationSlot,
      job: attestationJob,
    });
  }

  if (attestationSlot > latestPermissibleSlot) {
    throw new AttestationError({
      code: AttestationErrorCode.FUTURE_SLOT,
      latestPermissibleSlot,
      attestationSlot,
      job: attestationJob,
    });
  }

  // no other validator attestation for same target epoch has been seen
  if (db.seenAttestationCache.hasCommitteeAttestation(attestation)) {
    throw new AttestationError({
      code: AttestationErrorCode.ATTESTATION_ALREADY_KNOWN,
      root: config.types.phase0.Attestation.hashTreeRoot(attestation),
      job: attestationJob,
    });
  }

  if (await db.badBlock.has(attestation.data.beaconBlockRoot.valueOf() as Uint8Array)) {
    throw new AttestationError({
      code: AttestationErrorCode.KNOWN_BAD_BLOCK,
      job: attestationJob,
    });
  }

  if (!chain.forkChoice.hasBlock(attestation.data.beaconBlockRoot)) {
    throw new AttestationError({
      code: AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT,
      beaconBlockRoot: attestation.data.beaconBlockRoot as Uint8Array,
      job: attestationJob,
    });
  }

  let attestationPreState;
  try {
    attestationPreState = await chain.regen.getCheckpointState(attestation.data.target);
  } catch (e: unknown) {
    throw new AttestationError({
      code: AttestationErrorCode.MISSING_ATTESTATION_PRESTATE,
      job: attestationJob,
    });
  }

  const expectedSubnet = phase0.fast.computeSubnetForAttestation(config, attestationPreState, attestation);
  if (subnet !== expectedSubnet) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_SUBNET_ID,
      received: subnet,
      expected: expectedSubnet,
      job: attestationJob,
    });
  }

  if (
    !phase0.fast.isValidIndexedAttestation(
      attestationPreState,
      attestationPreState.getIndexedAttestation(attestation),
      true
    )
  ) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_SIGNATURE,
      job: attestationJob,
    });
  }

  if (!config.types.Epoch.equals(attestation.data.target.epoch, computeEpochAtSlot(config, attestationSlot))) {
    throw new AttestationError({
      code: AttestationErrorCode.BAD_TARGET_EPOCH,
      job: attestationJob,
    });
  }

  try {
    if (!isCommitteeIndexWithinRange(attestationPreState, attestation.data)) {
      throw new AttestationError({
        code: AttestationErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE,
        index: attestation.data.index,
        job: attestationJob,
      });
    }
  } catch (error) {
    throw new AttestationError({
      code: AttestationErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE,
      index: attestation.data.index,
      job: attestationJob,
    });
  }

  if (!doAggregationBitsMatchCommitteeSize(attestationPreState, attestation)) {
    throw new AttestationError({
      code: AttestationErrorCode.WRONG_NUMBER_OF_AGGREGATION_BITS,
      job: attestationJob,
    });
  }

  if (!chain.forkChoice.isDescendant(attestation.data.target.root, attestation.data.beaconBlockRoot)) {
    throw new AttestationError({
      code: AttestationErrorCode.TARGET_BLOCK_NOT_AN_ANCESTOR_OF_LMD_BLOCK,
      job: attestationJob,
    });
  }

  if (!chain.forkChoice.isDescendantOfFinalized(attestation.data.beaconBlockRoot)) {
    throw new AttestationError({
      code: AttestationErrorCode.FINALIZED_CHECKPOINT_NOT_AN_ANCESTOR_OF_ROOT,
      job: attestationJob,
    });
  }
  db.seenAttestationCache.addCommitteeAttestation(attestation);
}

export async function isAttestingToInValidBlock(db: IBeaconDb, attestation: phase0.Attestation): Promise<boolean> {
  const blockRoot = attestation.data.beaconBlockRoot.valueOf() as Uint8Array;
  // TODO: check if source and target blocks are not in bad block repository
  return await db.badBlock.has(blockRoot);
}

export function getAttestationAttesterCount(attestation: phase0.Attestation): number {
  return Array.from(attestation.aggregationBits).filter((bit) => !!bit).length;
}

export function isCommitteeIndexWithinRange(
  epochCtx: phase0.fast.EpochContext,
  attestationData: phase0.AttestationData
): boolean {
  return attestationData.index < epochCtx.getCommitteeCountAtSlot(attestationData.slot);
}

export function doAggregationBitsMatchCommitteeSize(
  epochCtx: phase0.fast.EpochContext,
  attestation: phase0.Attestation
): boolean {
  return (
    attestation.aggregationBits.length ===
    epochCtx.getBeaconCommittee(attestation.data.slot, attestation.data.index).length
  );
}
