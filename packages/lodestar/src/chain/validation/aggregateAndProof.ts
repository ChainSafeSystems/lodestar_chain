import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IAttestationJob, IBeaconChain} from "..";
import {IBeaconDb} from "../../db/api";
import {computeEpochAtSlot, isAggregatorFromCommitteeLength} from "@chainsafe/lodestar-beacon-state-transition";
import {phase0} from "@chainsafe/lodestar-beacon-state-transition";
import {isAttestingToInValidBlock} from "./attestation";
import {isValidAggregateAndProofSignature, isValidSelectionProofSignature} from "./utils";
import {AttestationError, AttestationErrorCode} from "../errors";
import {ATTESTATION_PROPAGATION_SLOT_RANGE} from "../../constants";

export async function validateGossipAggregateAndProof(
  config: IBeaconConfig,
  chain: IBeaconChain,
  db: IBeaconDb,
  signedAggregateAndProof: phase0.SignedAggregateAndProof,
  attestationJob: IAttestationJob
): Promise<void> {
  const aggregateAndProof = signedAggregateAndProof.message;
  const aggregate = aggregateAndProof.aggregate;

  const latestPermissibleSlot = chain.clock.currentSlot;
  const earliestPermissibleSlot = chain.clock.currentSlot - ATTESTATION_PROPAGATION_SLOT_RANGE;
  const attestationSlot = aggregate.data.slot;

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
      attestationSlot,
      latestPermissibleSlot,
      job: attestationJob,
    });
  }

  if (db.seenAttestationCache.hasAggregateAndProof(aggregateAndProof)) {
    throw new AttestationError({
      code: AttestationErrorCode.AGGREGATE_ALREADY_KNOWN,
      job: attestationJob,
    });
  }

  if (!hasAttestationParticipants(aggregate)) {
    // missing attestation participants
    throw new AttestationError({
      code: AttestationErrorCode.WRONG_NUMBER_OF_AGGREGATION_BITS,
      job: attestationJob,
    });
  }

  if (await isAttestingToInValidBlock(db, aggregate)) {
    throw new AttestationError({
      code: AttestationErrorCode.KNOWN_BAD_BLOCK,
      job: attestationJob,
    });
  }

  // TODO: check pool of aggregates if already seen (not a dos vector check)

  await validateAggregateAttestation(config, chain, signedAggregateAndProof, attestationJob);
}

export function hasAttestationParticipants(attestation: phase0.Attestation): boolean {
  return Array.from(attestation.aggregationBits).filter((bit) => !!bit).length >= 1;
}

export async function validateAggregateAttestation(
  config: IBeaconConfig,
  chain: IBeaconChain,
  aggregateAndProof: phase0.SignedAggregateAndProof,
  attestationJob: IAttestationJob
): Promise<void> {
  const attestation = aggregateAndProof.message.aggregate;
  let attestationPreState;
  try {
    // the target state, advanced to the attestation slot
    attestationPreState = await chain.regen.getBlockSlotState(attestation.data.target.root, attestation.data.slot);
  } catch (e: unknown) {
    throw new AttestationError({
      code: AttestationErrorCode.MISSING_ATTESTATION_PRESTATE,
      job: attestationJob,
    });
  }

  let committee;
  try {
    committee = attestationPreState.getBeaconCommittee(attestation.data.slot, attestation.data.index);
  } catch (error) {
    throw new AttestationError({
      code: AttestationErrorCode.AGGREGATOR_NOT_IN_COMMITTEE,
      job: attestationJob,
    });
  }

  if (!committee.includes(aggregateAndProof.message.aggregatorIndex)) {
    throw new AttestationError({
      code: AttestationErrorCode.AGGREGATOR_NOT_IN_COMMITTEE,
      job: attestationJob,
    });
  }

  if (!isAggregatorFromCommitteeLength(config, committee.length, aggregateAndProof.message.selectionProof)) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_AGGREGATOR,
      job: attestationJob,
    });
  }

  const aggregator = attestationPreState.index2pubkey[aggregateAndProof.message.aggregatorIndex];
  if (
    !isValidSelectionProofSignature(
      config,
      attestationPreState,
      attestation.data.slot,
      aggregator,
      aggregateAndProof.message.selectionProof.valueOf() as Uint8Array
    )
  ) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_SELECTION_PROOF,
      job: attestationJob,
    });
  }

  if (
    !isValidAggregateAndProofSignature(
      config,
      attestationPreState,
      computeEpochAtSlot(config, attestation.data.slot),
      aggregator,
      aggregateAndProof
    )
  ) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_SIGNATURE,
      job: attestationJob,
    });
  }

  // TODO: once we have pool, check if aggregate block is seen and has target as ancestor

  if (
    !phase0.fast.isValidIndexedAttestation(attestationPreState, attestationPreState.getIndexedAttestation(attestation))
  ) {
    throw new AttestationError({
      code: AttestationErrorCode.INVALID_SIGNATURE,
      job: attestationJob,
    });
  }
}
