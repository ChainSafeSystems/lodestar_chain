import PeerId from "peer-id";
import {IBeaconSync, ISyncModules, SyncingStatus} from "./interface";
import {INetwork, NetworkEvent} from "../network";
import {ILogger} from "@chainsafe/lodestar-utils";
import {SLOTS_PER_EPOCH} from "@chainsafe/lodestar-params";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Slot, phase0} from "@chainsafe/lodestar-types";
import {toHexString} from "@chainsafe/ssz";
import {ChainEvent, IBeaconChain} from "../chain";
import {BlockError, BlockErrorCode} from "../chain/errors";
import {RangeSync, RangeSyncStatus, RangeSyncEvent} from "./range/range";
import {fetchUnknownBlockRoot, getPeerSyncType, PeerSyncType} from "./utils";
import {MIN_EPOCH_TO_START_GOSSIP} from "./constants";
import {SyncState, SyncChainDebugState, syncStateMetric} from "./interface";
import {ISyncOptions} from "./options";
import {BackfillSync} from "./backfill";

export class BeaconSync implements IBeaconSync {
  private readonly config: IBeaconConfig;
  private readonly logger: ILogger;
  private readonly network: INetwork;
  private readonly chain: IBeaconChain;
  private readonly opts: ISyncOptions;

  private readonly rangeSync: RangeSync;
  private readonly backfillSync: BackfillSync;

  // avoid finding same root at the same time
  private readonly processingRoots = new Set<string>();

  /**
   * The number of slots ahead of us that is allowed before starting a RangeSync
   * If a peer is within this tolerance (forwards or backwards), it is treated as a fully sync'd peer.
   *
   * This means that we consider ourselves synced (and hence subscribe to all subnets and block
   * gossip if no peers are further than this range ahead of us that we have not already downloaded
   * blocks for.
   */
  private readonly slotImportTolerance: Slot;

  constructor(opts: ISyncOptions, modules: ISyncModules) {
    const {config, chain, metrics, network, logger} = modules;
    this.opts = opts;
    this.config = config;
    this.network = network;
    this.chain = chain;
    this.logger = logger;
    this.rangeSync = new RangeSync(modules, this.opts);
    this.backfillSync = new BackfillSync(modules);

    this.slotImportTolerance = SLOTS_PER_EPOCH;

    // Subscribe to RangeSync completing a SyncChain and recompute sync state
    this.rangeSync.on(RangeSyncEvent.completedChain, this.updateSyncState);
    this.network.events.on(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.on(NetworkEvent.peerDisconnected, this.removePeer);
    // TODO: It's okay to start this on initial sync?
    this.chain.emitter.on(ChainEvent.errorBlock, this.onUnknownBlockRoot);
    this.chain.emitter.on(ChainEvent.clockEpoch, this.onClockEpoch);

    if (metrics) {
      metrics.syncStatus.addCollect(() => metrics.syncStatus.set(syncStateMetric[this.state]));
    }
  }

  close(): void {
    this.network.events.off(NetworkEvent.peerConnected, this.addPeer);
    this.network.events.off(NetworkEvent.peerDisconnected, this.removePeer);
    this.chain.emitter.off(ChainEvent.errorBlock, this.onUnknownBlockRoot);
    this.chain.emitter.off(ChainEvent.clockEpoch, this.onClockEpoch);
    this.rangeSync.close();
    this.backfillSync.close();
  }

  getSyncStatus(): SyncingStatus {
    const currentSlot = this.chain.clock.currentSlot;
    const headSlot = this.chain.forkChoice.getHead().slot;
    switch (this.state) {
      case SyncState.SyncingFinalized:
      case SyncState.SyncingHead:
      case SyncState.Stalled:
        return {
          headSlot: headSlot,
          syncDistance: currentSlot - headSlot,
        };
      case SyncState.Synced:
        return {
          headSlot: headSlot,
          syncDistance: 0,
        };
      default:
        throw new Error("Node is stopped, cannot get sync status");
    }
  }

  isSyncing(): boolean {
    const state = this.state; // Don't run the getter twice
    return state === SyncState.SyncingFinalized || state === SyncState.SyncingHead;
  }

  isSynced(): boolean {
    return this.state === SyncState.Synced;
  }

  get state(): SyncState {
    const currentSlot = this.chain.clock.currentSlot;
    const headSlot = this.chain.forkChoice.getHead().slot;
    if (
      // Consider node synced IF
      // Before genesis OR
      (currentSlot < 0 ||
        // head is behind clock but close enough with some tolerance
        (headSlot <= currentSlot && headSlot >= currentSlot - this.slotImportTolerance)) &&
      // Ensure there at least one connected peer to not claim synced if has no peers
      // Allow to bypass this conditions for local networks with a single node
      (this.opts.isSingleNode || this.network.hasSomeConnectedPeer())
      // TODO: Consider enabling this condition (used in Lighthouse)
      // && headSlot > 0
    ) {
      return SyncState.Synced;
    }

    const rangeSyncState = this.rangeSync.state;
    switch (rangeSyncState.status) {
      case RangeSyncStatus.Finalized:
        return SyncState.SyncingFinalized;
      case RangeSyncStatus.Head:
        return SyncState.SyncingHead;
      case RangeSyncStatus.Idle:
        return SyncState.Stalled;
    }
  }

  /** Full debug state for lodestar API */
  getSyncChainsDebugState(): SyncChainDebugState[] {
    return this.rangeSync.getSyncChainsDebugState();
  }

  /**
   * A peer has connected which has blocks that are unknown to us.
   *
   * This function handles the logic associated with the connection of a new peer. If the peer
   * is sufficiently ahead of our current head, a range-sync (batch) sync is started and
   * batches of blocks are queued to download from the peer. Batched blocks begin at our latest
   * finalized head.
   *
   * If the peer is within the `SLOT_IMPORT_TOLERANCE`, then it's head is sufficiently close to
   * ours that we consider it fully sync'd with respect to our current chain.
   */
  private addPeer = (peerId: PeerId, peerStatus: phase0.Status): void => {
    const localStatus = this.chain.getStatus();
    const syncType = getPeerSyncType(localStatus, peerStatus, this.chain.forkChoice, this.slotImportTolerance);

    if (syncType === PeerSyncType.Advanced) {
      this.rangeSync.addPeer(peerId, localStatus, peerStatus);
    }

    this.updateSyncState();
  };

  /**
   * Must be called by libp2p when a peer is removed from the peer manager
   */
  private removePeer = (peerId: PeerId): void => {
    this.rangeSync.removePeer(peerId);
  };

  /**
   * Run this function when the sync state can potentially change.
   */
  private updateSyncState = (): void => {
    const state = this.state; // Don't run the getter twice

    // We have become synced, subscribe to all the gossip core topics
    if (
      state === SyncState.Synced &&
      !this.network.isSubscribedToGossipCoreTopics() &&
      this.chain.clock.currentSlot >= MIN_EPOCH_TO_START_GOSSIP
    ) {
      this.network.subscribeGossipCoreTopics();
      this.logger.info("Subscribed gossip core topics");
    }

    // If we stopped being synced and falled significantly behind, stop gossip
    if (state !== SyncState.Synced && this.network.isSubscribedToGossipCoreTopics()) {
      const syncDiff = this.chain.clock.currentSlot - this.chain.forkChoice.getHead().slot;
      if (syncDiff > this.slotImportTolerance * 2) {
        this.logger.warn(`Node sync has fallen behind by ${syncDiff} slots`);
        this.network.unsubscribeGossipCoreTopics();
        this.logger.info("Un-subscribed gossip core topics");
      }
    }
  };

  private onClockEpoch = (): void => {
    // If a node witness the genesis event consider starting gossip
    // Also, ensure that updateSyncState is run at least once per epoch.
    // If the chain gets or very overloaded it could helps to resolve the situation
    // by realizing it's way behind and turning gossip off.
    this.updateSyncState();
  };

  private onUnknownBlockRoot = async (err: BlockError): Promise<void> => {
    if (err.type.code !== BlockErrorCode.PARENT_UNKNOWN) return;

    const block = err.signedBlock.message;
    const blockRoot = this.config.getForkTypes(block.slot).BeaconBlock.hashTreeRoot(block);
    const parentRoot = this.chain.pendingBlocks.getMissingAncestor(blockRoot);
    const parentRootHex = toHexString(parentRoot);

    if (this.processingRoots.has(parentRootHex)) {
      return;
    }

    this.processingRoots.add(parentRootHex);
    this.logger.verbose("Finding block for unknown ancestor root", {parentRootHex});

    try {
      const block = await fetchUnknownBlockRoot(parentRoot, this.network, this.logger);
      this.chain.receiveBlock(block);
      this.logger.verbose("Found UnknownBlockRoot", {parentRootHex});
    } catch (e) {
      this.logger.verbose("Error fetching UnknownBlockRoot", {parentRootHex}, e);
    } finally {
      this.processingRoots.delete(parentRootHex);
    }
  };
}
