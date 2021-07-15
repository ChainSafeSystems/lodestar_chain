import {ByteVector, hash, toHexString, BitList, List} from "@chainsafe/ssz";
import bls, {CoordType, PublicKey} from "@chainsafe/bls";
import {
  BLSSignature,
  CommitteeIndex,
  Epoch,
  Slot,
  ValidatorIndex,
  phase0,
  allForks,
  Gwei,
  Number64,
} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {
  BASE_REWARD_FACTOR,
  DOMAIN_BEACON_PROPOSER,
  EFFECTIVE_BALANCE_INCREMENT,
  GENESIS_EPOCH,
  PROPOSER_WEIGHT,
  SLOTS_PER_EPOCH,
  SYNC_COMMITTEE_SIZE,
  SYNC_REWARD_WEIGHT,
  WEIGHT_DENOMINATOR,
} from "@chainsafe/lodestar-params";
import {bigIntSqrt, intToBytes, LodestarError} from "@chainsafe/lodestar-utils";

import {
  computeEpochAtSlot,
  computeProposerIndex,
  computeStartSlotAtEpoch,
  getSeed,
  getTotalActiveBalance,
  isAggregatorFromCommitteeLength,
  zipIndexesCommitteeBits,
} from "../../util";
import {computeEpochShuffling, IEpochShuffling} from "./epochShuffling";
import {MutableVector} from "@chainsafe/persistent-ts";
import {computeBaseRewardPerIncrement} from "../../altair/misc";

export type AttesterDuty = {
  // Index of validator in validator registry
  validatorIndex: ValidatorIndex;
  committeeIndex: CommitteeIndex;
  // Number of validators in committee
  committeeLength: Number64;
  // Number of committees at the provided slot
  committeesAtSlot: Number64;
  // Index of validator in committee
  validatorCommitteeIndex: Number64;
  // The slot at which the validator must attest.
  slot: Slot;
};

export type EpochContextOpts = {
  pubkey2index?: PubkeyIndexMap;
  index2pubkey?: PublicKey[];
  skipSyncPubkeys?: boolean;
};

type PubkeyHex = string;

function toHexStringMaybe(hex: ByteVector | string): string {
  return typeof hex === "string" ? hex : toHexString(hex);
}

export class PubkeyIndexMap {
  private readonly map = new Map<PubkeyHex, ValidatorIndex>();

  get size(): number {
    return this.map.size;
  }

  get(key: ByteVector | PubkeyHex): ValidatorIndex | undefined {
    return this.map.get(toHexStringMaybe(key));
  }

  set(key: ByteVector | PubkeyHex, value: ValidatorIndex): void {
    this.map.set(toHexStringMaybe(key), value);
  }
}

/**
 * Create an epoch cache
 * @param validators cached validators that matches `state.validators`
 */
export function createEpochContext(
  config: IBeaconConfig,
  state: allForks.BeaconState,
  validators: MutableVector<phase0.Validator>,
  opts?: EpochContextOpts
): EpochContext {
  const pubkey2index = opts?.pubkey2index || new PubkeyIndexMap();
  const index2pubkey = opts?.index2pubkey || ([] as PublicKey[]);
  if (!opts?.skipSyncPubkeys) {
    syncPubkeys(state, pubkey2index, index2pubkey);
  }

  const currentEpoch = computeEpochAtSlot(state.slot);
  const previousEpoch = currentEpoch === GENESIS_EPOCH ? GENESIS_EPOCH : currentEpoch - 1;
  const nextEpoch = currentEpoch + 1;

  const indicesBounded: [ValidatorIndex, Epoch, Epoch][] = validators.map((v, i) => [
    i,
    v.activationEpoch,
    v.exitEpoch,
  ]);

  const currentShuffling = computeEpochShuffling(state, indicesBounded, currentEpoch);
  let previousShuffling;
  if (previousEpoch === currentEpoch) {
    // in case of genesis
    previousShuffling = currentShuffling;
  } else {
    previousShuffling = computeEpochShuffling(state, indicesBounded, previousEpoch);
  }
  const nextShuffling = computeEpochShuffling(state, indicesBounded, nextEpoch);

  // Allow to create CachedBeaconState for empty states
  const proposers = state.validators.length > 0 ? computeProposers(state, currentShuffling) : [];

  // Only after altair, compute the indices of the current sync committee
  const onAltairFork = currentEpoch >= config.ALTAIR_FORK_EPOCH;

  const totalActiveBalance = getTotalActiveBalance(state);
  const syncParticipantReward = onAltairFork ? computeSyncParticipantReward(config, totalActiveBalance) : BigInt(0);
  const syncProposerReward = onAltairFork
    ? (syncParticipantReward * PROPOSER_WEIGHT) / (WEIGHT_DENOMINATOR - PROPOSER_WEIGHT)
    : BigInt(0);

  const baseRewardPerIncrement = onAltairFork ? computeBaseRewardPerIncrement(totalActiveBalance) : BigInt(0);

  return new EpochContext({
    config,
    pubkey2index,
    index2pubkey,
    proposers,
    previousShuffling,
    currentShuffling,
    nextShuffling,
    syncParticipantReward,
    syncProposerReward,
    baseRewardPerIncrement,
  });
}

/**
 * Checks the pubkey indices against a state and adds missing pubkeys
 *
 * Mutates `pubkey2index` and `index2pubkey`
 */
export function syncPubkeys(
  state: allForks.BeaconState,
  pubkey2index: PubkeyIndexMap,
  index2pubkey: PublicKey[]
): void {
  const currentCount = pubkey2index.size;
  if (currentCount !== index2pubkey.length) {
    throw new Error(`Pubkey indices have fallen out of sync: ${currentCount} != ${index2pubkey.length}`);
  }
  const newCount = state.validators.length;
  for (let i = currentCount; i < newCount; i++) {
    const pubkey = state.validators[i].pubkey.valueOf() as Uint8Array;
    pubkey2index.set(pubkey, i);
    // Pubkeys must be checked for group + inf. This must be done only once when the validator deposit is processed.
    // Afterwards any public key is the state consider validated.
    // > Do not do any validation here
    index2pubkey.push(bls.PublicKey.fromBytes(pubkey, CoordType.jacobian)); // Optimize for aggregation
  }
}

/**
 * Compute proposer indices for an epoch
 */
export function computeProposers(state: allForks.BeaconState, shuffling: IEpochShuffling): number[] {
  const epochSeed = getSeed(state, shuffling.epoch, DOMAIN_BEACON_PROPOSER);
  const startSlot = computeStartSlotAtEpoch(shuffling.epoch);
  const proposers = [];
  for (let slot = startSlot; slot < startSlot + SLOTS_PER_EPOCH; slot++) {
    proposers.push(
      computeProposerIndex(state, shuffling.activeIndices, hash(Buffer.concat([epochSeed, intToBytes(slot, 8)])))
    );
  }
  return proposers;
}

/**
 * Same logic in https://github.com/ethereum/eth2.0-specs/blob/v1.1.0-alpha.5/specs/altair/beacon-chain.md#sync-committee-processing
 */
export function computeSyncParticipantReward(config: IBeaconConfig, totalActiveBalance: Gwei): Gwei {
  const totalActiveIncrements = totalActiveBalance / EFFECTIVE_BALANCE_INCREMENT;
  const baseRewardPerIncrement =
    (EFFECTIVE_BALANCE_INCREMENT * BigInt(BASE_REWARD_FACTOR)) / bigIntSqrt(totalActiveBalance);
  const totalBaseRewards = baseRewardPerIncrement * totalActiveIncrements;
  const maxParticipantRewards = (totalBaseRewards * SYNC_REWARD_WEIGHT) / WEIGHT_DENOMINATOR / BigInt(SLOTS_PER_EPOCH);
  return maxParticipantRewards / BigInt(SYNC_COMMITTEE_SIZE);
}

/**
 * Called to re-use information, such as the shuffling of the next epoch, after transitioning into a
 * new epoch.
 */
export function rotateEpochs(
  epochCtx: EpochContext,
  state: allForks.BeaconState,
  indicesBounded: [ValidatorIndex, Epoch, Epoch][]
): void {
  epochCtx.previousShuffling = epochCtx.currentShuffling;
  epochCtx.currentShuffling = epochCtx.nextShuffling;
  const currEpoch = epochCtx.currentShuffling.epoch;
  const nextEpoch = currEpoch + 1;
  epochCtx.nextShuffling = computeEpochShuffling(state, indicesBounded, nextEpoch);
  epochCtx.proposers = computeProposers(state, epochCtx.currentShuffling);

  if (currEpoch >= epochCtx.config.ALTAIR_FORK_EPOCH) {
    const totalActiveBalance = getTotalActiveBalance(state);
    epochCtx.syncParticipantReward = computeSyncParticipantReward(epochCtx.config, totalActiveBalance);
    epochCtx.syncProposerReward =
      (epochCtx.syncParticipantReward * PROPOSER_WEIGHT) / (WEIGHT_DENOMINATOR - PROPOSER_WEIGHT);

    epochCtx.baseRewardPerIncrement = computeBaseRewardPerIncrement(totalActiveBalance);
  }
}

interface IEpochContextData {
  config: IBeaconConfig;
  pubkey2index: PubkeyIndexMap;
  index2pubkey: PublicKey[];
  proposers: number[];
  previousShuffling: IEpochShuffling;
  currentShuffling: IEpochShuffling;
  nextShuffling: IEpochShuffling;
  syncParticipantReward: Gwei;
  syncProposerReward: Gwei;
  baseRewardPerIncrement: Gwei;
}

/**
 * The standard / Exchange Interface of EpochContext, this is what's exported from
 * lodestar-beacon-state-transition.
 * A collection of contextual information to re-use during an epoch, and rotating precomputed data of
 * the next epoch into the current epoch. This includes shuffling, but also proposer information is
 * available.
 **/
export class EpochContext {
  // TODO: this is a hack, we need a safety mechanism in case a bad eth1 majority vote is in,
  // or handle non finalized data differently, or use an immutable.js structure for cheap copies
  // Warning: may contain pubkeys that do not yet exist in the current state, but do in a later processed state.
  pubkey2index: PubkeyIndexMap;
  // Warning: may contain indices that do not yet exist in the current state, but do in a later processed state.
  index2pubkey: PublicKey[];
  proposers: number[];
  // Per spec definition, shuffling will always be defined. They are never called before loadState()
  previousShuffling: IEpochShuffling;
  currentShuffling: IEpochShuffling;
  nextShuffling: IEpochShuffling;
  syncParticipantReward: phase0.Gwei;
  syncProposerReward: phase0.Gwei;
  config: IBeaconConfig;
  /**
   * Update freq: once per epoch after `process_effective_balance_updates()`
   * Memory cost: 1 bigint
   */
  baseRewardPerIncrement: Gwei;

  constructor(data: IEpochContextData) {
    this.config = data.config;
    this.pubkey2index = data.pubkey2index;
    this.index2pubkey = data.index2pubkey;
    this.proposers = data.proposers;
    this.previousShuffling = data.previousShuffling;
    this.currentShuffling = data.currentShuffling;
    this.nextShuffling = data.nextShuffling;
    this.syncParticipantReward = data.syncParticipantReward;
    this.syncProposerReward = data.syncProposerReward;
    this.baseRewardPerIncrement = data.baseRewardPerIncrement;
  }

  /**
   * Copies a given EpochContext while avoiding copying its immutable parts.
   */
  copy(): EpochContext {
    // warning: pubkey cache is not copied, it is shared, as eth1 is not expected to reorder validators.
    // Shallow copy all data from current epoch context to the next
    // All data is completely replaced, or only-appended
    return new EpochContext(this);
  }

  /**
   * Return the beacon committee at slot for index.
   */
  getBeaconCommittee(slot: Slot, index: CommitteeIndex): ValidatorIndex[] {
    const slotCommittees = this.getShufflingAtSlot(slot).committees[slot % SLOTS_PER_EPOCH];
    if (index >= slotCommittees.length) {
      throw new EpochContextError({
        code: EpochContextErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE,
        index,
        maxIndex: slotCommittees.length,
      });
    }
    return slotCommittees[index];
  }

  getCommitteeCountPerSlot(epoch: Epoch): number {
    return this.getShufflingAtEpoch(epoch).committeesPerSlot;
  }

  getBeaconProposer(slot: Slot): ValidatorIndex {
    const epoch = computeEpochAtSlot(slot);
    if (epoch !== this.currentShuffling.epoch) {
      throw new Error(
        `Requesting beacon proposer for different epoch current shuffling: ${epoch} != ${this.currentShuffling.epoch}`
      );
    }
    return this.proposers[slot % SLOTS_PER_EPOCH];
  }

  /**
   * Return the indexed attestation corresponding to ``attestation``.
   */
  getIndexedAttestation(attestation: phase0.Attestation): phase0.IndexedAttestation {
    const {aggregationBits, data} = attestation;
    const committeeIndices = this.getBeaconCommittee(data.slot, data.index);
    const attestingIndices = zipIndexesCommitteeBits(committeeIndices, aggregationBits);

    // sort in-place
    attestingIndices.sort((a, b) => a - b);
    return {
      attestingIndices: attestingIndices as List<number>,
      data: data,
      signature: attestation.signature,
    };
  }

  getAttestingIndices(data: phase0.AttestationData, bits: BitList): ValidatorIndex[] {
    const committeeIndices = this.getBeaconCommittee(data.slot, data.index);
    const validatorIndices = zipIndexesCommitteeBits(committeeIndices, bits);
    return validatorIndices;
  }

  getCommitteeAssignments(epoch: Epoch, requestedValidatorIndices: ValidatorIndex[]): AttesterDuty[] {
    const requestedValidatorIndicesSet = new Set(requestedValidatorIndices);
    const duties = [];
    const epochCommittees = this.getShufflingAtEpoch(epoch).committees;
    for (let epochSlot = 0; epochSlot < SLOTS_PER_EPOCH; epochSlot++) {
      const slotCommittees = epochCommittees[epochSlot];
      for (let i = 0, committeesAtSlot = slotCommittees.length; i < committeesAtSlot; i++) {
        for (let j = 0, committeeLength = slotCommittees[i].length; j < committeeLength; j++) {
          const validatorIndex = slotCommittees[i][j];
          if (requestedValidatorIndicesSet.has(validatorIndex)) {
            duties.push({
              validatorIndex,
              committeeLength,
              committeesAtSlot,
              validatorCommitteeIndex: j,
              committeeIndex: i,
              slot: epoch * SLOTS_PER_EPOCH + epochSlot,
            });
          }
        }
      }
    }
    return duties;
  }

  /**
   * Return the committee assignment in the ``epoch`` for ``validator_index``.
   * ``assignment`` returned is a tuple of the following form:
   * ``assignment[0]`` is the list of validators in the committee
   * ``assignment[1]`` is the index to which the committee is assigned
   * ``assignment[2]`` is the slot at which the committee is assigned
   * Return null if no assignment..
   */
  getCommitteeAssignment(epoch: Epoch, validatorIndex: ValidatorIndex): phase0.CommitteeAssignment | null {
    if (epoch > this.currentShuffling.epoch + 1) {
      throw Error(
        `Requesting committee assignment for more than 1 epoch ahead: ${epoch} > ${this.currentShuffling.epoch} + 1`
      );
    }

    const epochStartSlot = computeStartSlotAtEpoch(epoch);
    const committeeCountPerSlot = this.getCommitteeCountPerSlot(epoch);
    for (let slot = epochStartSlot; slot < epochStartSlot + SLOTS_PER_EPOCH; slot++) {
      for (let i = 0; i < committeeCountPerSlot; i++) {
        const committee = this.getBeaconCommittee(slot, i);
        if (committee.includes(validatorIndex)) {
          return {
            validators: committee as List<number>,
            committeeIndex: i,
            slot,
          };
        }
      }
    }
    return null;
  }

  isAggregator(slot: Slot, index: CommitteeIndex, slotSignature: BLSSignature): boolean {
    const committee = this.getBeaconCommittee(slot, index);
    return isAggregatorFromCommitteeLength(committee.length, slotSignature);
  }

  addPubkey(index: ValidatorIndex, pubkey: Uint8Array): void {
    this.pubkey2index.set(pubkey, index);
    this.index2pubkey[index] = bls.PublicKey.fromBytes(pubkey, CoordType.jacobian); // Optimize for aggregation
  }

  getShufflingAtSlot(slot: Slot): IEpochShuffling {
    const epoch = computeEpochAtSlot(slot);
    return this.getShufflingAtEpoch(epoch);
  }

  getShufflingAtEpoch(epoch: Epoch): IEpochShuffling {
    if (epoch === this.previousShuffling.epoch) {
      return this.previousShuffling;
    } else if (epoch === this.currentShuffling.epoch) {
      return this.currentShuffling;
    } else if (epoch === this.nextShuffling.epoch) {
      return this.nextShuffling;
    } else {
      throw new Error(`Requesting slot committee out of range epoch: ${epoch} current: ${this.currentShuffling.epoch}`);
    }
  }
}

export enum EpochContextErrorCode {
  COMMITTEE_INDEX_OUT_OF_RANGE = "EPOCH_CONTEXT_ERROR_COMMITTEE_INDEX_OUT_OF_RANGE",
}

type EpochContextErrorType = {
  code: EpochContextErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE;
  index: number;
  maxIndex: number;
};

export class EpochContextError extends LodestarError<EpochContextErrorType> {}
