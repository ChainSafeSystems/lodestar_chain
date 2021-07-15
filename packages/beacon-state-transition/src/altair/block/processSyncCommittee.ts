import {altair, ssz} from "@chainsafe/lodestar-types";
import {DOMAIN_SYNC_COMMITTEE} from "@chainsafe/lodestar-params";

import {
  computeSigningRoot,
  getBlockRootAtSlot,
  increaseBalance,
  decreaseBalance,
  ISignatureSet,
  SignatureSetType,
  verifySignatureSet,
  zipAllIndexesSyncCommitteeBits,
  zipIndexesSyncCommitteeBits,
  BlockProcess,
  getEmptyBlockProcess,
} from "../../util";
import {CachedBeaconState} from "../../allForks/util";

export function processSyncAggregate(
  state: CachedBeaconState<altair.BeaconState>,
  block: altair.BeaconBlock,
  blockProcess: BlockProcess = getEmptyBlockProcess(),
  verifySignatures = true
): void {
  const {syncParticipantReward, syncProposerReward} = state.epochCtx;
  const [participantIndices, unparticipantIndices] = getParticipantInfo(state, block.body.syncAggregate);

  // different from the spec but not sure how to get through signature verification for default/empty SyncAggregate in the spec test
  if (verifySignatures) {
    // This is to conform to the spec - we want the signature to be verified
    const signatureSet = getSyncCommitteeSignatureSet(state, block, participantIndices);
    // When there's no participation we consider the signature valid and just ignore i
    if (signatureSet !== null && !verifySignatureSet(signatureSet)) {
      throw Error("Sync committee signature invalid");
    }
  }

  const proposerIndex = state.epochCtx.getBeaconProposer(state.slot);
  // TODO: it's not efficient to update 1024 balances in the balances tree
  // consider if it's worth to implement asTransient(), asPersistent() for persistent-merkle-tree like in persistent-ts
  for (const participantIndex of participantIndices) {
    increaseBalance(state, participantIndex, syncParticipantReward);
  }
  const proposerReward = syncProposerReward * BigInt(participantIndices.length);
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
  for (const unparticipantIndex of unparticipantIndices) {
    decreaseBalance(state, unparticipantIndex, syncParticipantReward);
  }
}

export function getSyncCommitteeSignatureSet(
  state: CachedBeaconState<altair.BeaconState>,
  block: altair.BeaconBlock,
  /** Optional parameter to prevent computing it twice */
  participantIndices?: number[]
): ISignatureSet | null {
  const {epochCtx} = state;
  const {syncAggregate} = block.body;

  // The spec uses the state to get the previous slot
  // ```python
  // previous_slot = max(state.slot, Slot(1)) - Slot(1)
  // ```
  // However we need to run the function getSyncCommitteeSignatureSet() for all the blocks in a epoch
  // with the same state when verifying blocks in batch on RangeSync. Therefore we use the block.slot.
  //
  // This function expects that block.slot <= state.slot, otherwise we can't get the root sign by the sync committee.
  // process_sync_committee() is run at the end of process_block(). process_block() is run after process_slots()
  // which in the spec forces state.slot to equal block.slot.
  const previousSlot = Math.max(block.slot, 1) - 1;

  const rootSigned = getBlockRootAtSlot(state, previousSlot);

  if (!participantIndices) {
    participantIndices = getParticipantIndices(state, syncAggregate);
  }

  // When there's no participation we consider the signature valid and just ignore it
  if (participantIndices.length === 0) {
    return null;
  }

  const domain = state.config.getDomain(DOMAIN_SYNC_COMMITTEE, previousSlot);

  return {
    type: SignatureSetType.aggregate,
    pubkeys: participantIndices.map((i) => epochCtx.index2pubkey[i]),
    signingRoot: computeSigningRoot(ssz.Root, rootSigned, domain),
    signature: syncAggregate.syncCommitteeSignature.valueOf() as Uint8Array,
  };
}

/** Get participant indices for a sync committee. */
function getParticipantIndices(
  state: CachedBeaconState<altair.BeaconState>,
  syncAggregate: altair.SyncAggregate
): number[] {
  const committeeIndices = state.currentSyncCommittee.validatorIndices;
  return zipIndexesSyncCommitteeBits(committeeIndices, syncAggregate.syncCommitteeBits);
}

/** Return [0] as participant indices and [1] as unparticipant indices for a sync committee. */
function getParticipantInfo(
  state: CachedBeaconState<altair.BeaconState>,
  syncAggregate: altair.SyncAggregate
): [number[], number[]] {
  const committeeIndices = state.currentSyncCommittee.validatorIndices;
  return zipAllIndexesSyncCommitteeBits(committeeIndices, syncAggregate.syncCommitteeBits);
}
