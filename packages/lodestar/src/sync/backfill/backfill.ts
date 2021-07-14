import {computeStartSlotAtEpoch, allForks as allForksUtils} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {GENESIS_EPOCH} from "@chainsafe/lodestar-params";
import {phase0, Root, Slot, allForks, ssz} from "@chainsafe/lodestar-types";
import {ErrorAborted, ILogger} from "@chainsafe/lodestar-utils";
import {List} from "@chainsafe/ssz";
import PeerId from "peer-id";
import {IBeaconChain} from "../../chain";
import {getMinEpochForBlockRequests} from "../../constants";
import {IBeaconDb} from "../../db";
import {INetwork, NetworkEvent, PeerAction} from "../../network";
import {ItTrigger} from "../../util/itTrigger";
import {PeerMap} from "../../util/peerMap";
import {BackfillSyncError, BackfillSyncErrorCode} from "./errors";
import {getRandomPeer} from "./util";
import {verifyBlocks} from "./verify";

export enum BackfillSyncStatus {
  /** Required history blocks are syncing */
  Syncing,

  /** There are no suitable peers or we synced all required history blocks */
  Idle,
}

export type RangeSyncModules = {
  chain: IBeaconChain;
  db: IBeaconDb;
  network: INetwork;
  config: IBeaconConfig;
  logger: ILogger;
};

export type BackfillSyncOpts = {
  batchSize: number;
};

export class BackfillSync {
  private readonly chain: IBeaconChain;
  private readonly network: INetwork;
  private readonly db: IBeaconDb;
  private readonly config: IBeaconConfig;
  private readonly logger: ILogger;
  private opts: BackfillSyncOpts;
  //last fetched slot
  private lastFetchedSlot: Slot | null = null;
  //last trusted block
  private anchorBlock: allForks.SignedBeaconBlock | null = null;
  private processor: ItTrigger = new ItTrigger();
  private peers: PeerMap<phase0.Status | null> = new PeerMap();

  constructor(modules: RangeSyncModules, opts?: BackfillSyncOpts) {
    this.chain = modules.chain;
    this.network = modules.network;
    this.db = modules.db;
    this.config = modules.config;
    this.logger = modules.logger;
    this.opts = opts ?? {batchSize: 32};
    this.network.events.on(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.on(NetworkEvent.peerDisconnected, this.removePeer);
    this.network.getConnectedPeers().forEach((peer) => this.peers.set(peer, null));
    void this.init();
  }

  /** Throw / return all AsyncGenerators */
  close(): void {
    this.network.events.off(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.off(NetworkEvent.peerDisconnected, this.removePeer);
    this.processor.end(new ErrorAborted("BackfillSync"));
  }

  async init(): Promise<void> {
    const finalizedCheckpoint = this.chain.getFinalizedCheckpoint();
    this.logger.debug("Initializing backfill sync from finalizedCheckpoint", {
      checkpoint: ssz.phase0.Checkpoint.toJson(finalizedCheckpoint),
    });
    this.anchorBlock = await this.db.blockArchive.getByRoot(finalizedCheckpoint.root);
    void this.sync();
    this.processor.trigger();
  }

  async sync(): Promise<void> {
    try {
      for await (const _ of this.processor) {
        this.logger.debug("Backfill Sync - Peer count", {peerCount: this.peers.size});
        if (this.peers.size === 0) continue;

        const oldestRequiredEpoch = Math.max(
          GENESIS_EPOCH,
          this.chain.clock.currentEpoch - getMinEpochForBlockRequests(this.config)
        );
        const oldestSlotRequired = computeStartSlotAtEpoch(oldestRequiredEpoch);
        this.logger.debug("Backfill sync", {
          oldestSlotRequired,
          anchorSlot: this.anchorBlock?.message.slot ?? Infinity,
        });
        if (this.anchorBlock) {
          try {
            const toSlot = this.lastFetchedSlot ?? this.anchorBlock.message.slot;
            const fromSlot = Math.max(toSlot - this.opts.batchSize, oldestSlotRequired);
            if (fromSlot >= toSlot) {
              this.logger.info("Backfill sync completed");
              break;
            }
            this.logger.debug("BackfillSync - range sync", {
              fromSlot,
              toSlot,
              anchorSlot: this.anchorBlock.message.slot,
              lastFetched: this.lastFetchedSlot ?? -1,
            });
            await this.syncRange(fromSlot, toSlot, this.anchorBlock.message.parentRoot);
          } catch (e) {
            this.logger.debug("Error while backfiling by range", e);
          }
        } else {
          try {
            await this.syncBlock(this.chain.getFinalizedCheckpoint().root);
          } catch (e) {
            this.logger.debug("Error while backfilling anchor block", e);
          }
        }
      }
    } catch (e) {
      if (e instanceof ErrorAborted) {
        return; // Ignore
      }
      this.logger.error("BackfillSync Error", e);
    }
  }

  private addPeer = (peerId: PeerId, peerStatus: phase0.Status): void => {
    const requiredSlot =
      this.anchorBlock?.message.slot ?? computeStartSlotAtEpoch(this.chain.getFinalizedCheckpoint().epoch);
    this.logger.debug("Backfill sync - add peer", {peerhead: peerStatus.headSlot, requiredSlot});
    if (peerStatus.headSlot >= requiredSlot) {
      this.peers.set(peerId, peerStatus);
      this.processor.trigger();
    }
  };

  /**
   * Remove this peer from all sync chains
   */
  private removePeer(peerId: PeerId): void {
    this.network.peerRpcScores.applyAction(peerId, PeerAction.MidToleranceError);
    this.peers.delete(peerId);
  }

  private async syncBlock(root: Root): Promise<void> {
    const peer = getRandomPeer(this.peers.keys());
    try {
      const blocks = await this.network.reqResp.beaconBlocksByRoot(peer, [root] as List<Root>);
      if (blocks.length === 0) {
        throw new BackfillSyncError({code: BackfillSyncErrorCode.MISSING_BLOCKS, roots: [root], peerId: peer});
      }
      const block = blocks[0] as allForks.SignedBeaconBlock;
      if (
        !(await this.chain.bls.verifySignatureSets([
          allForksUtils.getProposerSignatureSet(this.chain.getHeadState(), block),
        ]))
      ) {
        throw new BackfillSyncError({code: BackfillSyncErrorCode.INVALID_SIGNATURE});
      }
      await this.db.blockArchive.put(block.message.slot, block);
      this.anchorBlock = block;
    } catch (e) {
      this.removePeer(peer);
      throw e;
    } finally {
      this.processor.trigger();
    }
  }

  private async syncRange(from: Slot, to: Slot, anchorRoot: Root): Promise<void> {
    const peer = getRandomPeer(this.peers.keys());
    try {
      const blocks = await this.network.reqResp.beaconBlocksByRange(peer, {startSlot: from, count: to - from, step: 1});
      await verifyBlocks(this.config, this.chain.bls, this.chain.getHeadState(), blocks, anchorRoot);
      await this.db.blockArchive.batchAdd(blocks);
      //first block is oldest
      this.anchorBlock = blocks[0];
      this.lastFetchedSlot = this.anchorBlock?.message.slot ?? null;
    } catch (e) {
      if ((e as BackfillSyncError).type.code === BackfillSyncErrorCode.NOT_ANCHORED) {
        this.lastFetchedSlot = this.anchorBlock?.message.slot ?? null;
      }
      this.removePeer(peer);
      throw e;
    } finally {
      this.processor.trigger();
    }
  }
}
