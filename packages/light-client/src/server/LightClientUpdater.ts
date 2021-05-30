import {altair} from "@chainsafe/lodestar-types";
import {ByteVector, toHexString, TreeBacked} from "@chainsafe/ssz";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {
  computeEpochAtSlot,
  computeSyncPeriodAtSlot,
  getBlockRootAtSlot,
  getForkVersion,
} from "@chainsafe/lodestar-beacon-state-transition";
import {FINALIZED_ROOT_INDEX, NEXT_SYNC_COMMITTEE_INDEX} from "@chainsafe/lodestar-params";
import {Checkpoint, Epoch, LightClientUpdate, Slot, SyncPeriod} from "@chainsafe/lodestar-types/lib/altair";
import {isZeroHash, sumBits, toBlockHeader} from "../utils/utils";

type DbRepo<K, T> = {put(key: K, data: T): Promise<void>; get(key: K): Promise<T | null>};
type DbItem<T> = {put(data: T): Promise<void>; get(): Promise<T | null>};

export type SyncAttestedData = Pick<
  LightClientUpdate,
  "finalityBranch" | "header" | "nextSyncCommittee" | "nextSyncCommitteeBranch"
> & {finalizedCheckpoint: altair.Checkpoint};

export type FinalizedCheckpointData = Pick<
  LightClientUpdate,
  "header" | "nextSyncCommittee" | "nextSyncCommitteeBranch"
>;

type CommitteeSignatureData = {
  slot: Slot;
  forkVersion: ByteVector;
  syncAggregate: altair.SyncAggregate;
};

export type LightClientUpdaterDb = {
  /**
   * We do not persist every finalized checkpoint state. So persist the minimal data necessary to build updates
   */
  lightclientFinalizedCheckpoint: DbRepo<Epoch, FinalizedCheckpointData>;
  /**
   * Persist the best update per committee period acording to `isBetterUpdate()`.
   * May include finalized and non-finalized updates.
   *
   * Must persist the best update for each committee period between the longest possible weak subjectivity epoch and now.
   */
  bestUpdatePerCommitteePeriod: DbRepo<SyncPeriod, LightClientUpdate>;
  latestFinalizedUpdate: DbItem<LightClientUpdate>;
  latestNonFinalizedUpdate: DbItem<LightClientUpdate>;
};

/**
 * In normal conditions a size of 1 would be enough. A high number of items is only necessary in heavy forking
 */
const PREV_DATA_MAX_SIZE = 64;

export interface ILightClientUpdater {
  getBestUpdates(periods: SyncPeriod[]): Promise<altair.LightClientUpdate[]>;
  getLatestUpdateFinalized(): Promise<altair.LightClientUpdate | null>;
  getLatestUpdateNonFinalized(): Promise<altair.LightClientUpdate | null>;
}

/**
 * Compute and cache LightClientUpdate objects as the chain advances
 *
 * Spec v1.0.1
 */
export class LightClientUpdater implements ILightClientUpdater {
  private readonly prevHeadData = new Map<string, SyncAttestedData>();
  private readonly zero: Pick<
    LightClientUpdate,
    "nextSyncCommittee" | "nextSyncCommitteeBranch" | "finalityBranch" | "finalityHeader"
  >;

  constructor(private readonly config: IBeaconConfig, private readonly db: LightClientUpdaterDb) {
    // Cache the zero default values to not compute them every time
    this.zero = {
      nextSyncCommittee: this.config.types.altair.SyncCommittee.defaultValue(),
      nextSyncCommitteeBranch: this.config.types.altair.LightClientUpdate.getPropertyType(
        "nextSyncCommitteeBranch"
      ).defaultValue() as LightClientUpdate["nextSyncCommitteeBranch"],
      finalityHeader: this.config.types.phase0.BeaconBlockHeader.defaultValue(),
      finalityBranch: this.config.types.altair.LightClientUpdate.getPropertyType(
        "finalityBranch"
      ).defaultValue() as LightClientUpdate["finalityBranch"],
    };
  }

  /**
   * To be called in API route GET /eth/v1/lightclient/best_update/:periods
   */
  async getBestUpdates(periods: SyncPeriod[]): Promise<LightClientUpdate[]> {
    const updates: LightClientUpdate[] = [];
    for (const period of periods) {
      const update = await this.db.bestUpdatePerCommitteePeriod.get(period);
      if (update) updates.push(update);
    }
    return updates;
  }

  /**
   * To be called in API route GET /eth/v1/lightclient/latest_update_finalized/
   */
  async getLatestUpdateFinalized(): Promise<LightClientUpdate | null> {
    return this.db.latestFinalizedUpdate.get();
  }

  /**
   * To be called in API route GET /eth/v1/lightclient/latest_update_nonfinalized/
   */
  async getLatestUpdateNonFinalized(): Promise<LightClientUpdate | null> {
    return this.db.latestNonFinalizedUpdate.get();
  }

  /**
   * Must subscribe to BeaconChain event `head`
   *
   * On head store the syncAggregate and:
   * - Keep the best syncAggregate from the latest finalized checkpoint
   * - When finalizing a new checkpoint, compute the rest of the proof and persist
   * - Consider persisting the best of the best per comittee period in another db repo
   * - Consider storing two best sync aggregates: the one with most bits and the one with most full aggregate sigs
   */
  async onHead(block: altair.BeaconBlock, postState: TreeBacked<altair.BeaconState>): Promise<void> {
    // Store a proof expected to be attested by the sync committee in a future block
    // Prove that the `finalizedCheckpointRoot` belongs in that block
    this.prevHeadData.set(toHexString(this.config.types.altair.BeaconBlock.hashTreeRoot(block)), {
      finalizedCheckpoint: postState.finalizedCheckpoint,
      finalityBranch: postState.tree.getSingleProof(BigInt(FINALIZED_ROOT_INDEX)),
      header: toBlockHeader(this.config, block),
      nextSyncCommittee: postState.nextSyncCommittee,
      // Prove that the `nextSyncCommittee` is included in a finalized state "attested" by the current sync committee
      nextSyncCommitteeBranch: postState.tree.getSingleProof(BigInt(NEXT_SYNC_COMMITTEE_INDEX)),
    });

    // Store syncAggregate associated to the attested blockRoot
    const syncAttestedBlockRoot = getBlockRootAtSlot(this.config, postState, postState.slot - 1);
    const signatureData: CommitteeSignatureData = {
      // Track the signature slot since that's what decides the committeePeriod
      slot: block.slot,
      // Get the ForkVersion used in the syncAggregate, as verified in the state transition fn
      forkVersion: getForkVersion(postState.fork, computeEpochAtSlot(this.config, block.slot)),
      syncAggregate: block.body.syncAggregate,
    };

    // Recover attested data from prevData cache. If not found, this SyncAggregate is useless
    const syncAttestedData = this.prevHeadData.get(toHexString(syncAttestedBlockRoot));
    if (!syncAttestedData) {
      return;
    }

    // Store the best finalized update per period
    const committeePeriodWithFinalized = await this.persistBestFinalizedUpdate(syncAttestedData, signatureData);
    // Then, store the best non finalized update per period
    await this.persistBestNonFinalizedUpdate(syncAttestedData, signatureData, committeePeriodWithFinalized);

    // Prune old prevHeadData
    if (this.prevHeadData.size > PREV_DATA_MAX_SIZE) {
      for (const key of this.prevHeadData.keys()) {
        this.prevHeadData.delete(key);
        if (this.prevHeadData.size <= PREV_DATA_MAX_SIZE) {
          break;
        }
      }
    }
  }

  /**
   * Must subcribe to BeaconChain event `finalizedCheckpoint`.
   * Expects the block from `checkpoint.root` and the post state of the block, `block.stateRoot`
   *
   * NOTE: Must be called also on start with the current finalized checkpoint (may be genesis)
   */
  async onFinalized(
    checkpoint: Checkpoint,
    block: altair.BeaconBlock,
    postState: TreeBacked<altair.BeaconState>
  ): Promise<void> {
    // Pre-compute the nextSyncCommitteeBranch for this checkpoint, it will never change
    await this.db.lightclientFinalizedCheckpoint.put(checkpoint.epoch, {
      header: toBlockHeader(this.config, block),
      nextSyncCommittee: postState.nextSyncCommittee,
      // Prove that the `nextSyncCommittee` is included in a finalized state "attested" by the current sync committee
      nextSyncCommitteeBranch: postState.tree.getSingleProof(BigInt(NEXT_SYNC_COMMITTEE_INDEX)),
    });

    // TODO: Prune `db.lightclientFinalizedCheckpoint` for epoch < checkpoint.epoch
    // No block will reference the previous finalized checkpoint anymore
  }

  /**
   * Store the best syncAggregate per finalizedEpoch
   */
  private async persistBestFinalizedUpdate(
    syncAttestedData: SyncAttestedData,
    signatureData: CommitteeSignatureData
  ): Promise<SyncPeriod | null> {
    // Retrieve finality branch for attested finalized checkpoint
    const finalizedEpoch = syncAttestedData.finalizedCheckpoint.epoch;
    const finalizedData = await this.db.lightclientFinalizedCheckpoint.get(finalizedEpoch);

    // If there's no finalized data available for this epoch, we can't create an update
    // TODO: Review if we can recover this data from the previous best update maybe, then prune
    //       Note: The next best update will point to the same finalized checkpoint or a more recent
    if (!finalizedData) {
      return null;
    }

    // NOTE: The `finalizedData.header` must be in the same SyncPeriod as the signature period.
    // Note, that the `syncAttestedData.header` period is > finalizedData & < signaturePeriod.
    // Otherwise a different committee will be the signer of a previous update and the lightclient
    // won't be able to validate it because it hasn't switched to the next syncCommittee yet
    const committeePeriod = computeSyncPeriodAtSlot(this.config, finalizedData.header.slot);
    const signaturePeriod = computeSyncPeriodAtSlot(this.config, signatureData.slot);
    if (committeePeriod !== signaturePeriod) {
      return null;
    }

    const newUpdate: LightClientUpdate = {
      header: finalizedData.header,
      nextSyncCommittee: finalizedData.nextSyncCommittee,
      nextSyncCommitteeBranch: finalizedData.nextSyncCommitteeBranch,
      finalityHeader: syncAttestedData.header,
      finalityBranch: syncAttestedData.finalityBranch,
      syncCommitteeBits: signatureData.syncAggregate.syncCommitteeBits,
      syncCommitteeSignature: signatureData.syncAggregate.syncCommitteeSignature,
      forkVersion: signatureData.forkVersion,
    };

    const prevBestUpdate = await this.db.bestUpdatePerCommitteePeriod.get(committeePeriod);
    if (!prevBestUpdate || isBetterUpdate(prevBestUpdate, newUpdate)) {
      await this.db.bestUpdatePerCommitteePeriod.put(committeePeriod, newUpdate);
    }

    const prevLatestUpdate = await this.db.latestFinalizedUpdate.get();
    if (!prevLatestUpdate || isLatestBestFinalizedUpdate(prevLatestUpdate, newUpdate)) {
      await this.db.latestFinalizedUpdate.put(newUpdate);
    }

    return committeePeriod;
  }

  /**
   * Store the best syncAggregate per committeePeriod in case finality is not reached
   */
  private async persistBestNonFinalizedUpdate(
    syncAttestedData: SyncAttestedData,
    signatureData: CommitteeSignatureData,
    committeePeriodWithFinalized: SyncPeriod | null
  ): Promise<void> {
    const committeePeriod = computeSyncPeriodAtSlot(this.config, syncAttestedData.header.slot);
    const signaturePeriod = computeSyncPeriodAtSlot(this.config, signatureData.slot);
    if (committeePeriod !== signaturePeriod) {
      return;
    }

    const newUpdate: LightClientUpdate = {
      header: syncAttestedData.header,
      nextSyncCommittee: syncAttestedData.nextSyncCommittee,
      nextSyncCommitteeBranch: syncAttestedData.nextSyncCommitteeBranch,
      finalityHeader: this.zero.finalityHeader,
      finalityBranch: this.zero.finalityBranch,
      syncCommitteeBits: signatureData.syncAggregate.syncCommitteeBits,
      syncCommitteeSignature: signatureData.syncAggregate.syncCommitteeSignature,
      forkVersion: signatureData.forkVersion,
    };

    // Optimization: If there's already a finalized update for this committee period, no need to create a non-finalized update
    if (committeePeriodWithFinalized !== committeePeriod) {
      const prevBestUpdate = await this.db.bestUpdatePerCommitteePeriod.get(committeePeriod);
      if (!prevBestUpdate || isBetterUpdate(prevBestUpdate, newUpdate)) {
        await this.db.bestUpdatePerCommitteePeriod.put(committeePeriod, newUpdate);
      }
    }

    // Store the latest update here overall. Not checking it's the best
    const prevLatestUpdate = await this.db.latestNonFinalizedUpdate.get();
    if (!prevLatestUpdate || isLatestBestNonFinalizedUpdate(prevLatestUpdate, newUpdate)) {
      // TODO: Don't store nextCommittee, that can be fetched through getBestUpdates()
      await this.db.latestNonFinalizedUpdate.put(newUpdate);
    }
  }
}

/**
 * Returns the update with more bits. On ties, newUpdate is the better
 */
function isBetterUpdate(prevUpdate: LightClientUpdate, newUpdate: LightClientUpdate): boolean {
  const prevIsFinalized = isFinalizedUpdate(prevUpdate);
  const newIsFinalized = isFinalizedUpdate(newUpdate);

  // newUpdate becomes finalized, it's better
  if (newIsFinalized && !prevIsFinalized) return true;
  // newUpdate is no longer finalized, it's worse
  if (!newIsFinalized && prevIsFinalized) return false;
  // For two finalized, or two non-finalized: compare bit count
  return sumBits(newUpdate.syncCommitteeBits) >= sumBits(prevUpdate.syncCommitteeBits);
}

function isLatestBestFinalizedUpdate(prevUpdate: LightClientUpdate, newUpdate: LightClientUpdate): boolean {
  if (newUpdate.finalityHeader.slot > prevUpdate.finalityHeader.slot) return true;
  if (newUpdate.finalityHeader.slot < prevUpdate.finalityHeader.slot) return false;
  return sumBits(newUpdate.syncCommitteeBits) >= sumBits(prevUpdate.syncCommitteeBits);
}

function isLatestBestNonFinalizedUpdate(prevUpdate: LightClientUpdate, newUpdate: LightClientUpdate): boolean {
  if (newUpdate.header.slot > prevUpdate.header.slot) return true;
  if (newUpdate.header.slot < prevUpdate.header.slot) return false;
  return sumBits(newUpdate.syncCommitteeBits) >= sumBits(prevUpdate.syncCommitteeBits);
}

function isFinalizedUpdate(update: LightClientUpdate): boolean {
  return !isZeroHash(update.finalityHeader.stateRoot);
}
