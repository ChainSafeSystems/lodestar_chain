/**
 * @module chain
 */

import {
  CachedBeaconState,
  computeEpochAtSlot,
  computeForkDigest,
  computeForkNameFromForkDigest,
  computeStartSlotAtEpoch,
} from "@chainsafe/lodestar-beacon-state-transition";
import {phase0} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig, IForkName} from "@chainsafe/lodestar-config";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";
import {ForkDigest, Number64, Root, Slot} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {TreeBacked} from "@chainsafe/ssz";
import {AbortController} from "abort-controller";
import {FAR_FUTURE_EPOCH, GENESIS_EPOCH, ZERO_HASH} from "../constants";
import {IBeaconDb} from "../db";
import {CheckpointStateCache, StateContextCache} from "./stateCache";
import {IBeaconMetrics} from "../metrics";
import {AttestationPool, AttestationProcessor} from "./attestation";
import {BlockPool, BlockProcessor} from "./blocks";
import {IBeaconClock, LocalClock} from "./clock";
import {ChainEventEmitter} from "./emitter";
import {handleChainEvents} from "./eventHandlers";
import {IBeaconChain} from "./interface";
import {IChainOptions} from "./options";
import {IStateRegenerator, QueuedStateRegenerator} from "./regen";
import {LodestarForkChoice} from "./forkChoice";
import {restoreStateCaches} from "./initState";

export interface IBeaconChainModules {
  opts: IChainOptions;
  config: IBeaconConfig;
  db: IBeaconDb;
  logger: ILogger;
  metrics?: IBeaconMetrics;
  anchorState: TreeBacked<phase0.BeaconState>;
}

export class BeaconChain implements IBeaconChain {
  readonly genesisTime: Number64;
  readonly genesisValidatorsRoot: Root;

  forkChoice: IForkChoice;
  clock: IBeaconClock;
  emitter: ChainEventEmitter;
  stateCache: StateContextCache;
  checkpointStateCache: CheckpointStateCache;
  regen: IStateRegenerator;
  pendingAttestations: AttestationPool;
  pendingBlocks: BlockPool;

  protected attestationProcessor: AttestationProcessor;
  protected blockProcessor: BlockProcessor;
  protected readonly config: IBeaconConfig;
  protected readonly db: IBeaconDb;
  protected readonly logger: ILogger;
  protected readonly metrics?: IBeaconMetrics;
  protected readonly opts: IChainOptions;
  /**
   * Internal event emitter is used internally to the chain to update chain state
   * Once event have been handled internally, they are re-emitted externally for downstream consumers
   */
  protected internalEmitter: ChainEventEmitter;
  private abortController: AbortController;

  constructor({opts, config, db, logger, metrics, anchorState}: IBeaconChainModules) {
    this.opts = opts;
    this.config = config;
    this.db = db;
    this.logger = logger;
    this.metrics = metrics;

    this.genesisTime = anchorState.genesisTime;
    this.genesisValidatorsRoot = anchorState.genesisValidatorsRoot.valueOf() as Uint8Array;
    this.abortController = new AbortController();

    this.emitter = new ChainEventEmitter();
    this.internalEmitter = new ChainEventEmitter();

    this.clock = new LocalClock({
      config: this.config,
      emitter: this.internalEmitter,
      genesisTime: this.genesisTime,
      signal: this.abortController.signal,
    });
    this.stateCache = new StateContextCache();
    this.checkpointStateCache = new CheckpointStateCache(this.config);
    const cachedState = restoreStateCaches(config, this.stateCache, this.checkpointStateCache, anchorState);
    this.forkChoice = new LodestarForkChoice({
      config,
      emitter: this.internalEmitter,
      currentSlot: this.clock.currentSlot,
      state: cachedState,
    });
    this.regen = new QueuedStateRegenerator({
      config: this.config,
      emitter: this.internalEmitter,
      forkChoice: this.forkChoice,
      stateCache: this.stateCache,
      checkpointStateCache: this.checkpointStateCache,
      db: this.db,
      signal: this.abortController.signal,
    });
    this.pendingAttestations = new AttestationPool({
      config: this.config,
    });
    this.pendingBlocks = new BlockPool({
      config: this.config,
    });
    this.attestationProcessor = new AttestationProcessor({
      config: this.config,
      forkChoice: this.forkChoice,
      emitter: this.internalEmitter,
      clock: this.clock,
      regen: this.regen,
    });
    this.blockProcessor = new BlockProcessor({
      config: this.config,
      forkChoice: this.forkChoice,
      clock: this.clock,
      regen: this.regen,
      metrics: this.metrics,
      emitter: this.internalEmitter,
      checkpointStateCache: this.checkpointStateCache,
      signal: this.abortController.signal,
    });
    handleChainEvents.bind(this)(this.abortController.signal);
  }

  close(): void {
    this.abortController.abort();
    this.stateCache.clear();
    this.checkpointStateCache.clear();
  }

  getGenesisTime(): Number64 {
    return this.genesisTime;
  }

  getHeadState(): CachedBeaconState<phase0.BeaconState> {
    // head state should always exist
    const head = this.forkChoice.getHead();
    const headState =
      this.checkpointStateCache.getLatest({
        root: head.blockRoot,
        epoch: Infinity,
      }) || this.stateCache.get(head.stateRoot);
    if (!headState) throw Error("headState does not exist");
    return headState;
  }

  async getHeadStateAtCurrentEpoch(): Promise<CachedBeaconState<phase0.BeaconState>> {
    const currentEpochStartSlot = computeStartSlotAtEpoch(this.config, this.clock.currentEpoch);
    const head = this.forkChoice.getHead();
    const bestSlot = currentEpochStartSlot > head.slot ? currentEpochStartSlot : head.slot;
    return await this.regen.getBlockSlotState(head.blockRoot, bestSlot);
  }

  async getHeadStateAtCurrentSlot(): Promise<CachedBeaconState<phase0.BeaconState>> {
    return await this.regen.getBlockSlotState(this.forkChoice.getHeadRoot(), this.clock.currentSlot);
  }

  async getHeadBlock(): Promise<phase0.SignedBeaconBlock | null> {
    const headSummary = this.forkChoice.getHead();
    const unfinalizedBlock = await this.db.block.get(headSummary.blockRoot);
    if (unfinalizedBlock) {
      return unfinalizedBlock;
    }
    return await this.db.blockArchive.get(headSummary.slot);
  }

  async getCanonicalBlockAtSlot(slot: Slot): Promise<phase0.SignedBeaconBlock | null> {
    const finalizedCheckpoint = this.forkChoice.getFinalizedCheckpoint();
    if (finalizedCheckpoint.epoch > computeEpochAtSlot(this.config, slot)) {
      return this.db.blockArchive.get(slot);
    }
    const summary = this.forkChoice.getCanonicalBlockSummaryAtSlot(slot);
    if (!summary) {
      return null;
    }
    return await this.db.block.get(summary.blockRoot);
  }

  async getStateByBlockRoot(blockRoot: Root): Promise<CachedBeaconState<phase0.BeaconState> | null> {
    const blockSummary = this.forkChoice.getBlock(blockRoot);
    if (!blockSummary) {
      return null;
    }
    try {
      return await this.regen.getState(blockSummary.stateRoot);
    } catch (e: unknown) {
      return null;
    }
  }

  /** Returned blocks have the same ordering as `slots` */
  async getUnfinalizedBlocksAtSlots(slots: Slot[]): Promise<phase0.SignedBeaconBlock[]> {
    if (slots.length === 0) {
      return [];
    }

    const slotsSet = new Set(slots);
    const blockRootsPerSlot = new Map<Slot, Promise<phase0.SignedBeaconBlock | null>>();

    // these blocks are on the same chain to head
    for (const summary of this.forkChoice.iterateBlockSummaries(this.forkChoice.getHeadRoot())) {
      if (slotsSet.has(summary.slot)) {
        blockRootsPerSlot.set(summary.slot, this.db.block.get(summary.blockRoot));
      }
    }

    const unfinalizedBlocks = await Promise.all(slots.map((slot) => blockRootsPerSlot.get(slot)));
    return unfinalizedBlocks.filter((block): block is phase0.SignedBeaconBlock => block != null);
  }

  getFinalizedCheckpoint(): phase0.Checkpoint {
    return this.forkChoice.getFinalizedCheckpoint();
  }

  receiveAttestation(attestation: phase0.Attestation): void {
    this.attestationProcessor
      .processAttestationJob({attestation, validSignature: false})
      .catch(() => /* unreachable */ ({}));
  }

  receiveBlock(signedBlock: phase0.SignedBeaconBlock, trusted = false): void {
    this.blockProcessor
      .processBlockJob({
        signedBlock,
        reprocess: false,
        prefinalized: trusted,
        validSignatures: trusted,
        validProposerSignature: trusted,
      })
      .catch(() => /* unreachable */ ({}));
  }

  async processChainSegment(signedBlocks: phase0.SignedBeaconBlock[], trusted = false): Promise<void> {
    return await this.blockProcessor.processChainSegment({
      signedBlocks,
      reprocess: false,
      prefinalized: trusted,
      validSignatures: trusted,
      validProposerSignature: trusted,
    });
  }

  getForkDigest(): ForkDigest {
    const state = this.getHeadState();
    return computeForkDigest(this.config, state.fork.currentVersion, this.genesisValidatorsRoot);
  }

  getForkName(): IForkName {
    return computeForkNameFromForkDigest(this.config, this.genesisValidatorsRoot, this.getForkDigest());
  }

  getENRForkID(): phase0.ENRForkID {
    const state = this.getHeadState();
    const currentVersion = state.fork.currentVersion;

    const forkDigest = this.getForkDigest();

    return {
      forkDigest,
      // TODO figure out forking
      nextForkVersion: currentVersion.valueOf() as Uint8Array,
      nextForkEpoch: FAR_FUTURE_EPOCH,
    };
  }

  getStatus(): phase0.Status {
    const head = this.forkChoice.getHead();
    const finalizedCheckpoint = this.forkChoice.getFinalizedCheckpoint();
    return {
      forkDigest: this.getForkDigest(),
      finalizedRoot: finalizedCheckpoint.epoch === GENESIS_EPOCH ? ZERO_HASH : finalizedCheckpoint.root,
      finalizedEpoch: finalizedCheckpoint.epoch,
      headRoot: head.blockRoot,
      headSlot: head.slot,
    };
  }
}
