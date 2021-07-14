import PeerId from "peer-id";
import {Epoch, Root, Slot, phase0, allForks} from "@chainsafe/lodestar-types";
import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {ErrorAborted, ILogger} from "@chainsafe/lodestar-utils";
import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {toHexString} from "@chainsafe/ssz";
import {PeerAction} from "../../network";
import {ChainSegmentError} from "../../chain/errors";
import {ItTrigger} from "../../util/itTrigger";
import {byteArrayEquals} from "../../util/bytes";
import {PeerMap} from "../../util/peerMap";
import {wrapError} from "../../util/wrapError";
import {RangeSyncType} from "../utils";
import {BATCH_BUFFER_SIZE, EPOCHS_PER_BATCH, BATCH_SLOT_OFFSET} from "../constants";
import {Batch, BatchError, BatchErrorCode, BatchMetadata, BatchOpts, BatchStatus} from "./batch";
import {
  validateBatchesStatus,
  getNextBatchToProcess,
  toBeProcessedStartEpoch,
  toBeDownloadedStartEpoch,
  toArr,
  ChainPeersBalancer,
  computeMostCommonTarget,
} from "./utils";

export type SyncChainOpts = Partial<BatchOpts>;

export type SyncChainModules = {
  config: IChainForkConfig;
  logger: ILogger;
};

export type SyncChainFns = {
  /**
   * Must return if ALL blocks are processed successfully
   * If SOME blocks are processed must throw BlockProcessorError()
   */
  processChainSegment: (blocks: allForks.SignedBeaconBlock[]) => Promise<void>;
  /** Must download blocks, and validate their range */
  downloadBeaconBlocksByRange: (
    peer: PeerId,
    request: phase0.BeaconBlocksByRangeRequest
  ) => Promise<allForks.SignedBeaconBlock[]>;
  /** Report peer for negative actions. Decouples from the full network instance */
  reportPeer: (peer: PeerId, action: PeerAction, actionName: string) => void;
  /** Hook called when Chain state completes */
  onEnd: (err?: Error) => void;
};

/**
 * Sync this up to this target. Uses slot instead of epoch to re-use logic for finalized sync
 * and head sync. The root is used to uniquely identify this chain on different forks
 */
export type ChainTarget = {
  slot: Slot;
  root: Root;
};

export class SyncChainStartError extends Error {}

export type SyncChainDebugState = {
  targetRoot: string | null;
  targetSlot: number | null;
  syncType: RangeSyncType;
  status: SyncChainStatus;
  startEpoch: number;
  peers: number;
  batches: BatchMetadata[];
};

export enum SyncChainStatus {
  Stopped = "Stopped",
  Syncing = "Syncing",
  Synced = "Synced",
  Error = "Error",
}

/**
 * Dynamic target sync chain. Peers with multiple targets but with the same syncType are added
 * through the `addPeer()` hook.
 *
 * A chain of blocks that need to be downloaded. Peers who claim to contain the target head
 * root are grouped into the peer pool and queried for batches when downloading the chain.
 */
export class SyncChain {
  /** Short string id to identify this SyncChain in logs */
  readonly logId: string;
  readonly syncType: RangeSyncType;
  /** Should sync up until this slot, then stop */
  target: ChainTarget | null = null;

  /** Number of validated epochs. For the SyncRange to prevent switching chains too fast */
  validatedEpochs = 0;

  /** The start of the chain segment. Any epoch previous to this one has been validated. */
  private startEpoch: Epoch;
  private status = SyncChainStatus.Stopped;

  private readonly processChainSegment: SyncChainFns["processChainSegment"];
  private readonly downloadBeaconBlocksByRange: SyncChainFns["downloadBeaconBlocksByRange"];
  private readonly reportPeer: SyncChainFns["reportPeer"];
  /** AsyncIterable that guarantees processChainSegment is run only at once at anytime */
  private readonly batchProcessor = new ItTrigger();
  /** Sorted map of batches undergoing some kind of processing. */
  private readonly batches = new Map<Epoch, Batch>();
  private readonly peerset = new PeerMap<ChainTarget>();

  private readonly logger: ILogger;
  private readonly config: IChainForkConfig;
  private readonly opts: BatchOpts;

  constructor(
    startEpoch: Epoch,
    syncType: RangeSyncType,
    fns: SyncChainFns,
    modules: SyncChainModules,
    opts?: SyncChainOpts
  ) {
    this.startEpoch = startEpoch;
    this.syncType = syncType;
    this.processChainSegment = fns.processChainSegment;
    this.downloadBeaconBlocksByRange = fns.downloadBeaconBlocksByRange;
    this.reportPeer = fns.reportPeer;
    this.config = modules.config;
    this.logger = modules.logger;
    this.opts = {epochsPerBatch: opts?.epochsPerBatch ?? EPOCHS_PER_BATCH};
    this.logId = `${syncType}`;

    // Trigger event on parent class
    this.sync().then(
      () => fns.onEnd(),
      (e) => fns.onEnd(e)
    );
  }

  /**
   * Start syncing a new chain or an old one with an existing peer list
   * In the same call, advance the chain if localFinalizedEpoch >
   */
  startSyncing(localFinalizedEpoch: Epoch): void {
    switch (this.status) {
      case SyncChainStatus.Stopped:
        break; // Ok, continue
      case SyncChainStatus.Syncing:
        return; // Skip, already started
      case SyncChainStatus.Error:
      case SyncChainStatus.Synced:
        throw new SyncChainStartError(`Attempted to start an ended SyncChain ${this.status}`);
    }

    this.status = SyncChainStatus.Syncing;

    // to avoid dropping local progress, we advance the chain with its batch boundaries.
    // get the aligned epoch that produces a batch containing the `localFinalizedEpoch`
    const localFinalizedEpochAligned =
      this.startEpoch + Math.floor((localFinalizedEpoch - this.startEpoch) / EPOCHS_PER_BATCH) * EPOCHS_PER_BATCH;
    this.advanceChain(localFinalizedEpochAligned);

    // Potentially download new batches and process pending
    this.triggerBatchDownloader();
    this.triggerBatchProcessor();
  }

  /**
   * Temporarily stop the chain. Will prevent batches from being processed
   */
  stopSyncing(): void {
    this.status = SyncChainStatus.Stopped;
  }

  /**
   * Permanently remove this chain. Throws the main AsyncIterable
   */
  remove(): void {
    this.batchProcessor.end(new ErrorAborted("SyncChain"));
  }

  /**
   * Add peer to the chain and request batches if active
   */
  addPeer(peer: PeerId, target: ChainTarget): void {
    this.peerset.set(peer, target);
    this.computeTarget();
    this.triggerBatchDownloader();
  }

  /**
   * Returns true if the peer existed and has been removed
   * NOTE: The RangeSync will take care of deleting the SyncChain if peers = 0
   */
  removePeer(peerId: PeerId): boolean {
    const deleted = this.peerset.delete(peerId);
    this.computeTarget();
    return deleted;
  }

  /**
   * Helper to print internal state for debugging when chain gets stuck
   */
  getBatchesState(): BatchMetadata[] {
    return toArr(this.batches).map((batch) => batch.getMetadata());
  }

  get startEpochValue(): Epoch {
    return this.startEpoch;
  }

  get isSyncing(): boolean {
    return this.status === SyncChainStatus.Syncing;
  }

  get isRemovable(): boolean {
    return this.status === SyncChainStatus.Error || this.status === SyncChainStatus.Synced;
  }

  get peers(): number {
    return this.peerset.size;
  }

  getPeers(): PeerId[] {
    return this.peerset.keys();
  }

  /** Full debug state for lodestar API */
  getDebugState(): SyncChainDebugState {
    return {
      targetRoot: this.target && toHexString(this.target.root),
      targetSlot: this.target && this.target.slot,
      syncType: this.syncType,
      status: this.status,
      startEpoch: this.startEpoch,
      peers: this.peers,
      batches: this.getBatchesState(),
    };
  }

  private computeTarget(): void {
    const targets = this.peerset.values();
    this.target = computeMostCommonTarget(targets);
  }

  /**
   * Main Promise that handles the sync process. Will resolve when initial sync completes
   * i.e. when it successfully processes a epoch >= than this chain `targetEpoch`
   */
  private async sync(): Promise<void> {
    try {
      // Start processing batches on demand in strict sequence
      for await (const _ of this.batchProcessor) {
        if (this.status !== SyncChainStatus.Syncing) {
          continue;
        }

        // TODO: Consider running this check less often after the sync is well tested
        validateBatchesStatus(toArr(this.batches));

        // If startEpoch of the next batch to be processed > targetEpoch -> Done
        const toBeProcessedEpoch = toBeProcessedStartEpoch(toArr(this.batches), this.startEpoch, this.opts);
        if (this.target && computeStartSlotAtEpoch(toBeProcessedEpoch) >= this.target.slot) {
          break;
        }

        // Processes the next batch if ready
        const batch = getNextBatchToProcess(toArr(this.batches));
        if (batch) await this.processBatch(batch);
      }

      this.status = SyncChainStatus.Synced;
      this.logger.verbose("SyncChain Synced", {id: this.logId});
    } catch (e) {
      if (e instanceof ErrorAborted) {
        return; // Ignore
      }

      this.status = SyncChainStatus.Error;
      this.logger.verbose("SyncChain Error", {id: this.logId}, e);

      // A batch could not be processed after max retry limit. It's likely that all peers
      // in this chain are sending invalid batches repeatedly so are either malicious or faulty.
      // We drop the chain and report all peers.
      // There are some edge cases with forks that could cause this situation, but it's unlikely.
      if (e instanceof BatchError && e.type.code === BatchErrorCode.MAX_PROCESSING_ATTEMPTS) {
        for (const peer of this.peerset.keys()) {
          this.reportPeer(peer, PeerAction.LowToleranceError, "SyncChainMaxProcessingAttempts");
        }
      }

      // TODO: Should peers be reported for MAX_DOWNLOAD_ATTEMPTS?

      throw e;
    }
  }

  /**
   * Request to process batches if possible
   */
  private triggerBatchProcessor(): void {
    this.batchProcessor.trigger();
  }

  /**
   * Request to download batches if possible
   * Backlogs requests into a single pending request
   */
  private triggerBatchDownloader(): void {
    try {
      this.requestBatches(this.peerset.keys());
    } catch (e) {
      // bubble the error up to the main async iterable loop
      this.batchProcessor.end(e);
    }
  }

  /**
   * Attempts to request the next required batches from the peer pool if the chain is syncing.
   * It will exhaust the peer pool and left over batches until the batch buffer is reached.
   */
  private requestBatches(peers: PeerId[]): void {
    if (this.status !== SyncChainStatus.Syncing) {
      return;
    }

    const peerBalancer = new ChainPeersBalancer(peers, toArr(this.batches));

    // Retry download of existing batches
    for (const batch of this.batches.values()) {
      if (batch.state.status !== BatchStatus.AwaitingDownload) {
        continue;
      }

      const peer = peerBalancer.bestPeerToRetryBatch(batch);
      if (peer) {
        void this.sendBatch(batch, peer);
      }
    }

    // find the next pending batch and request it from the peer
    for (const peer of peerBalancer.idlePeers()) {
      const batch = this.includeNextBatch();
      if (!batch) {
        break;
      }
      void this.sendBatch(batch, peer);
    }
  }

  /**
   * Creates the next required batch from the chain. If there are no more batches required, returns `null`.
   */
  private includeNextBatch(): Batch | null {
    const batches = toArr(this.batches);

    // Only request batches up to the buffer size limit
    // Note: Don't count batches in the AwaitingValidation state, to prevent stalling sync
    // if the current processing window is contained in a long range of skip slots.
    const batchesInBuffer = batches.filter((batch) => {
      return batch.state.status === BatchStatus.Downloading || batch.state.status === BatchStatus.AwaitingProcessing;
    });
    if (batchesInBuffer.length > BATCH_BUFFER_SIZE) {
      return null;
    }

    // This line decides the starting epoch of the next batch. MUST ensure no duplicate batch for the same startEpoch
    const startEpoch = toBeDownloadedStartEpoch(batches, this.startEpoch, this.opts);
    const toBeDownloadedSlot = computeStartSlotAtEpoch(startEpoch) + BATCH_SLOT_OFFSET;

    // Don't request batches beyond the target head slot
    if (this.target && toBeDownloadedSlot > this.target.slot) {
      return null;
    }

    if (this.batches.has(startEpoch)) {
      this.logger.error("Attempting to add existing Batch to SyncChain", {id: this.logId, startEpoch});
      return null;
    }

    const batch = new Batch(startEpoch, this.config, this.opts);
    this.batches.set(startEpoch, batch);
    return batch;
  }

  /**
   * Requests the batch asigned to the given id from a given peer.
   */
  private async sendBatch(batch: Batch, peer: PeerId): Promise<void> {
    try {
      batch.startDownloading(peer);

      // wrapError ensures to never call both batch success() and batch error()
      const res = await wrapError(this.downloadBeaconBlocksByRange(peer, batch.request));

      if (!res.err) {
        batch.downloadingSuccess(res.result);
        this.triggerBatchProcessor();
      } else {
        this.logger.verbose("Batch download error", {id: this.logId, ...batch.getMetadata()}, res.err);
        batch.downloadingError(); // Throws after MAX_DOWNLOAD_ATTEMPTS
      }

      // Pre-emptively request more blocks from peers whilst we process current blocks
      this.triggerBatchDownloader();
    } catch (e) {
      // bubble the error up to the main async iterable loop
      this.batchProcessor.end(e);
    }

    // Pre-emptively request more blocks from peers whilst we process current blocks
    this.triggerBatchDownloader();
  }

  /**
   * Sends `batch` to the processor. Note: batch may be empty
   */
  private async processBatch(batch: Batch): Promise<void> {
    const blocks = batch.startProcessing();

    // wrapError ensures to never call both batch success() and batch error()
    const res = await wrapError(this.processChainSegment(blocks));

    if (!res.err) {
      batch.processingSuccess();

      // If the processed batch is not empty, validate previous AwaitingValidation blocks.
      if (blocks.length > 0) {
        this.advanceChain(batch.startEpoch);
      }

      // Potentially process next AwaitingProcessing batch
      this.triggerBatchProcessor();
    } else {
      this.logger.verbose("Batch process error", {id: this.logId, ...batch.getMetadata()}, res.err);
      batch.processingError(); // Throws after MAX_BATCH_PROCESSING_ATTEMPTS

      // At least one block was successfully verified and imported, so we can be sure all
      // previous batches are valid and we only need to download the current failed batch.
      if (res.err instanceof ChainSegmentError && res.err.importedBlocks > 0) {
        this.advanceChain(batch.startEpoch);
      }

      // The current batch could not be processed, so either this or previous batches are invalid.
      // All previous batches (AwaitingValidation) are potentially faulty and marked for retry.
      // Progress will be drop back to `this.startEpoch`
      for (const pendingBatch of this.batches.values()) {
        if (pendingBatch.startEpoch < batch.startEpoch) {
          this.logger.verbose("Batch validation error", {id: this.logId, ...pendingBatch.getMetadata()});
          pendingBatch.validationError(); // Throws after MAX_BATCH_PROCESSING_ATTEMPTS
        }
      }
    }

    // A batch is no longer in Processing status, queue has an empty spot to download next batch
    this.triggerBatchDownloader();
  }

  /**
   * Drops any batches previous to `newStartEpoch` and updates the chain boundaries
   */
  private advanceChain(newStartEpoch: Epoch): void {
    // make sure this epoch produces an advancement
    if (newStartEpoch <= this.startEpoch) {
      return;
    }

    for (const [batchKey, batch] of this.batches.entries()) {
      if (batch.startEpoch < newStartEpoch) {
        this.batches.delete(batchKey);
        this.validatedEpochs += EPOCHS_PER_BATCH;

        // The last batch attempt is right, all others are wrong. Penalize other peers
        const attemptOk = batch.validationSuccess();
        for (const attempt of batch.failedProcessingAttempts) {
          if (!byteArrayEquals(attempt.hash, attemptOk.hash)) {
            if (attemptOk.peer.toB58String() === attempt.peer.toB58String()) {
              // The same peer corrected its previous attempt
              this.reportPeer(attempt.peer, PeerAction.MidToleranceError, "SyncChainInvalidBatchSelf");
            } else {
              // A different peer sent an bad batch
              this.reportPeer(attempt.peer, PeerAction.LowToleranceError, "SyncChainInvalidBatchOther");
            }
          }
        }
      }
    }

    this.startEpoch = newStartEpoch;
  }
}
