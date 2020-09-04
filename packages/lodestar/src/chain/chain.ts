/**
 * @module chain
 */

import AbortController from "abort-controller";
import {toHexString, TreeBacked} from "@chainsafe/ssz";
import {
  Attestation,
  BeaconState,
  Checkpoint,
  ENRForkID,
  ForkDigest,
  Number64,
  Root,
  SignedBeaconBlock,
  Slot,
  Uint16,
  Uint64,
} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {computeEpochAtSlot, computeForkDigest, EpochContext} from "@chainsafe/lodestar-beacon-state-transition";
import {ILogger} from "@chainsafe/lodestar-utils/lib/logger";
import {intToBytes} from "@chainsafe/lodestar-utils";

import {EMPTY_SIGNATURE, GENESIS_SLOT, FAR_FUTURE_EPOCH} from "../constants";
import {IBeaconDb} from "../db";
import {IEth1Provider} from "../eth1";
import {IBeaconMetrics} from "../metrics";
import {GenesisBuilder} from "./genesis/genesis";
import {ArrayDagLMDGHOST, ILMDGHOST} from "./forkChoice";
import {ChainEventEmitter} from "./emitter";

import {IAttestationProcessor, IBeaconChain} from "./interface";
import {IChainOptions} from "./options";
import {AttestationProcessor} from "./attestation";
import {IBeaconClock, LocalClock} from "./clock";
import {BlockProcessor} from "./blocks";
import {sortBlocks} from "../sync/utils";
import {getEmptyBlock} from "./genesis/util";
import {ITreeStateContext} from "../db/api/beacon/stateContextCache";
import {notNullish} from "../util/notNullish";

export interface IBeaconChainModules {
  config: IBeaconConfig;
  db: IBeaconDb;
  eth1Provider: IEth1Provider;
  logger: ILogger;
  metrics: IBeaconMetrics;
  forkChoice?: ILMDGHOST;
}

export interface IBlockProcessJob {
  signedBlock: SignedBeaconBlock;
  trusted: boolean;
  reprocess: boolean;
}

export class BeaconChain implements IBeaconChain {
  public forkChoice!: ILMDGHOST;
  public chainId: Uint16;
  public networkId: Uint64;
  public clock!: IBeaconClock;
  public emitter: ChainEventEmitter;
  private readonly config: IBeaconConfig;
  private readonly db: IBeaconDb;
  private readonly eth1Provider: IEth1Provider;
  private readonly logger: ILogger;
  private readonly metrics: IBeaconMetrics;
  private readonly opts: IChainOptions;
  private blockProcessor!: BlockProcessor;
  private _currentForkDigest!: ForkDigest;
  private attestationProcessor!: IAttestationProcessor;
  private genesisTime: Number64 = 0;
  private abortController?: AbortController;

  public constructor(opts: IChainOptions, {config, db, eth1Provider, logger, metrics}: IBeaconChainModules) {
    this.opts = opts;
    this.config = config;
    this.db = db;
    this.eth1Provider = eth1Provider;
    this.logger = logger;
    this.metrics = metrics;
    this.emitter = new ChainEventEmitter();
    this.chainId = 0; // TODO make this real
    this.networkId = BigInt(0); // TODO make this real
  }

  public getGenesisTime(): Number64 {
    return this.genesisTime;
  }

  public async getHeadStateContext(): Promise<ITreeStateContext> {
    //head state should always exist
    const headStateContext = await this.db.stateCache.get(this.forkChoice.headStateRoot());
    if (!headStateContext) throw Error("headStateRoot does not exist");
    return headStateContext;
  }

  public async getHeadState(): Promise<BeaconState> {
    return (await this.db.state.get(this.forkChoice.headStateRoot()!)) as BeaconState;
  }
  public async getHeadEpochContext(): Promise<EpochContext> {
    //head should always have epoch ctx
    return (await this.getHeadStateContext()).epochCtx;
  }

  public async getHeadBlock(): Promise<SignedBeaconBlock | null> {
    const headSummary = this.forkChoice.head();
    if (!headSummary) {
      return null;
    }
    const unfinalizedBlock = await this.db.block.get(headSummary.blockRoot);
    if (unfinalizedBlock) {
      return unfinalizedBlock;
    }
    return await this.db.blockArchive.get(headSummary.slot);
  }

  public async getCanonicalBlockAtSlot(slot: Slot): Promise<SignedBeaconBlock | null> {
    const finalizedCheckpoint = this.forkChoice.getFinalized()!;
    if (finalizedCheckpoint.epoch > computeEpochAtSlot(this.config, slot)) {
      return this.db.blockArchive.get(slot);
    }
    const summary = this.forkChoice.getCanonicalBlockSummaryAtSlot(slot);
    if (!summary) {
      return null;
    }
    return this.db.block.get(summary.blockRoot);
  }

  public async getStateContextByBlockRoot(blockRoot: Root): Promise<ITreeStateContext | null> {
    const blockSummary = this.forkChoice.getBlockSummaryByBlockRoot(blockRoot.valueOf() as Uint8Array);
    if (!blockSummary) {
      return null;
    }
    const stateContext = await this.db.stateCache.get(blockSummary.stateRoot);
    if (!stateContext) {
      return null;
    }
    return stateContext;
  }

  public async getUnfinalizedBlocksAtSlots(slots: Slot[]): Promise<SignedBeaconBlock[] | null> {
    if (!slots) {
      return null;
    }
    const blockRoots = slots
      .map((slot) => {
        const summary = this.forkChoice.getCanonicalBlockSummaryAtSlot(slot);
        return summary ? summary.blockRoot : null;
      })
      .filter(notNullish);
    // these blocks are on the same chain to head
    const unfinalizedBlocks = await Promise.all(blockRoots.map((blockRoot) => this.db.block.get(blockRoot)));
    return unfinalizedBlocks.filter(notNullish);
  }

  public async getFinalizedCheckpoint(): Promise<Checkpoint> {
    return this.forkChoice.getFinalized()!;
  }

  public async start(): Promise<void> {
    this.abortController = new AbortController();
    this.logger.verbose("Starting chain");
    // if we run from scratch, we want to wait for genesis state
    const state = await this.waitForState();
    this.genesisTime = state.genesisTime;
    const epochCtx = new EpochContext(this.config);
    epochCtx.loadState(state);
    await this.db.stateCache.add({state, epochCtx});
    this.logger.info("Chain started, waiting blocks and attestations");
    this.clock = new LocalClock({
      config: this.config,
      emitter: this.emitter,
      genesisTime: state.genesisTime,
      signal: this.abortController.signal,
    });
    this.forkChoice = new ArrayDagLMDGHOST({
      config: this.config,
      emitter: this.emitter,
      genesisTime: state.genesisTime,
    });
    this.attestationProcessor = new AttestationProcessor(this, {
      config: this.config,
      db: this.db,
      logger: this.logger,
    });
    this.blockProcessor = new BlockProcessor(
      this.config,
      this.logger,
      this.db,
      this.forkChoice,
      this.metrics,
      this.emitter,
      this.attestationProcessor
    );
    await this.blockProcessor.start();
    await this.attestationProcessor.start();
    this._currentForkDigest = computeForkDigest(this.config, state.fork.currentVersion, state.genesisValidatorsRoot);
    this.emitter.on("forkVersion", this.handleForkVersionChanged);
    this.emitter.on("clock:epoch", this.onClockEpoch);
    this.emitter.on("checkpoint", this.onCheckpoint);
    await this.restoreHeadState(state, epochCtx);
  }

  public async stop(): Promise<void> {
    this.abortController!.abort();
    await this.attestationProcessor.stop();
    await this.blockProcessor.stop();
    this.emitter.removeListener("forkVersion", this.handleForkVersionChanged);
    this.emitter.removeListener("clock:epoch", this.onClockEpoch);
    this.emitter.removeListener("checkpoint", this.onCheckpoint);
  }

  public get currentForkDigest(): ForkDigest {
    return this._currentForkDigest;
  }

  public async receiveAttestation(attestation: Attestation): Promise<void> {
    return this.attestationProcessor.receiveAttestation(attestation);
  }

  public async receiveBlock(signedBlock: SignedBeaconBlock, trusted = false, reprocess = false): Promise<void> {
    this.blockProcessor.receiveBlock(signedBlock, trusted, reprocess);
  }

  public async initializeBeaconChain(genesisState: TreeBacked<BeaconState>): Promise<void> {
    // don't want to initialize from a genesis state if already run beacon node
    const lastKnownState = await this.db.stateArchive.lastValue();
    if (lastKnownState) {
      this.logger.info(`Found finalized state at slot ${lastKnownState.slot}, starting chain from there`);
      return;
    }
    const genesisBlock = getEmptyBlock();
    const stateRoot = this.config.types.BeaconState.hashTreeRoot(genesisState);
    genesisBlock.stateRoot = stateRoot;
    const blockRoot = this.config.types.BeaconBlock.hashTreeRoot(genesisBlock);
    this.logger.info("Initializing genesis state", {
      stateRoot: toHexString(stateRoot),
      blockRoot: toHexString(blockRoot),
      validatorCount: genesisState.validators.length,
    });
    // Determine whether a genesis state already in
    // the database matches what we were provided
    const storedGenesisBlock = await this.db.blockArchive.get(GENESIS_SLOT);
    if (
      storedGenesisBlock !== null &&
      !this.config.types.Root.equals(genesisBlock.stateRoot, storedGenesisBlock.message.stateRoot)
    ) {
      throw new Error("A genesis state with different configuration was detected! Please clean the database.");
    }
    const signedGenesisBlock = {message: genesisBlock, signature: EMPTY_SIGNATURE};
    await Promise.all([this.db.blockArchive.add(signedGenesisBlock), this.db.stateArchive.add(genesisState)]);
    this.logger.info("Beacon chain initialized");
  }

  public async getENRForkID(): Promise<ENRForkID> {
    const state = await this.getHeadState();
    const currentVersion = state.fork.currentVersion;
    const nextVersion =
      this.config.params.ALL_FORKS &&
      this.config.params.ALL_FORKS.find((fork) =>
        this.config.types.Version.equals(currentVersion, intToBytes(fork.previousVersion, 4))
      );
    return {
      forkDigest: this.currentForkDigest,
      nextForkVersion: nextVersion
        ? intToBytes(nextVersion.currentVersion, 4)
        : (currentVersion.valueOf() as Uint8Array),
      nextForkEpoch: nextVersion ? nextVersion.epoch : FAR_FUTURE_EPOCH,
    };
  }

  public async waitForBlockProcessed(blockRoot: Uint8Array): Promise<void> {
    await new Promise((resolve) => {
      const listener = (signedBlock: SignedBeaconBlock): void => {
        const root = this.config.types.BeaconBlock.hashTreeRoot(signedBlock.message);
        if (this.config.types.Root.equals(root, blockRoot)) {
          this.emitter.removeListener("block", listener);
          resolve();
        }
      };
      this.emitter.on("block", listener);
    });
  }

  /**
   * Restore state cache and forkchoice from last finalized state.
   */
  private async restoreHeadState(lastKnownState: TreeBacked<BeaconState>, epochCtx: EpochContext): Promise<void> {
    const stateRoot = this.config.types.BeaconState.hashTreeRoot(lastKnownState);
    this.logger.info("Restoring from last known state", {
      slot: lastKnownState.slot,
      epoch: computeEpochAtSlot(this.config, lastKnownState.slot),
      stateRoot: toHexString(stateRoot),
    });
    this.logger.profile("restoreHeadState");
    await this.db.stateCache.add({state: lastKnownState, epochCtx});
    // there might be blocks in the archive we need to reprocess
    const finalizedBlocks = await this.db.blockArchive.values({gt: lastKnownState.slot});
    // the block respective to finalized epoch still in block db
    const unfinalizedBlocks = await this.db.block.values();
    if (!unfinalizedBlocks || unfinalizedBlocks.length === 0) {
      await this.initForkChoice(lastKnownState);
      return;
    }
    const sortedBlocks = finalizedBlocks.concat(sortBlocks(unfinalizedBlocks));
    const firstBlock = sortedBlocks[0];
    const lastBlock = sortedBlocks[sortedBlocks.length - 1];
    let firstSlot = firstBlock.message.slot;
    let lastSlot = lastBlock.message.slot;
    this.logger.info(
      `Found ${sortedBlocks.length} nonfinalized blocks in database from slot ` + `${firstSlot} to ${lastSlot}`
    );
    await this.initForkChoice(lastKnownState);
    if (!sortedBlocks.length) {
      this.logger.info("No need to reprocess blocks");
      return;
    }
    firstSlot = sortedBlocks[0].message.slot;
    lastSlot = sortedBlocks[sortedBlocks.length - 1].message.slot;
    this.logger.info(`Start processing from slot ${firstSlot} to ${lastSlot} to rebuild state cache and forkchoice`);
    await Promise.all([
      ...sortedBlocks.map((block) => this.receiveBlock(block, true, true)),
      this.waitForBlockProcessed(this.config.types.BeaconBlock.hashTreeRoot(lastBlock.message)),
    ]);
    this.logger.important(`Finish restoring chain head from ${sortedBlocks.length} blocks`);
    this.logger.profile("restoreHeadState");
  }

  /**
   * Seeds the fork choice with an anchor state.
   * This state is set as the finalized state.
   */
  private async initForkChoice(anchorState: TreeBacked<BeaconState>): Promise<void> {
    let blockRoot;
    let justifiedCheckpoint;
    let finalizedCheckpoint;
    if (anchorState.latestBlockHeader.slot === GENESIS_SLOT) {
      const block = getEmptyBlock();
      block.stateRoot = this.config.types.BeaconState.hashTreeRoot(anchorState);
      blockRoot = this.config.types.BeaconBlock.hashTreeRoot(block);
      const blockCheckpoint = {
        root: blockRoot,
        epoch: computeEpochAtSlot(this.config, anchorState.slot),
      };
      justifiedCheckpoint = blockCheckpoint;
      finalizedCheckpoint = blockCheckpoint;
    } else {
      const blockHeader = this.config.types.BeaconBlockHeader.clone(anchorState.latestBlockHeader);
      blockHeader.stateRoot = this.config.types.BeaconState.hashTreeRoot(anchorState);
      blockRoot = this.config.types.BeaconBlockHeader.hashTreeRoot(blockHeader);
      justifiedCheckpoint = anchorState.currentJustifiedCheckpoint;
      finalizedCheckpoint = anchorState.finalizedCheckpoint;
    }
    this.forkChoice.addBlock({
      slot: anchorState.slot,
      blockRoot,
      stateRoot: this.config.types.BeaconState.hashTreeRoot(anchorState),
      parentRoot: anchorState.latestBlockHeader.parentRoot.valueOf() as Uint8Array,
      justifiedCheckpoint,
      finalizedCheckpoint,
    });
  }

  private handleForkVersionChanged = async (): Promise<void> => {
    this._currentForkDigest = await this.getCurrentForkDigest();
    this.emitter.emit("forkDigest", this._currentForkDigest);
  };

  private async getCurrentForkDigest(): Promise<ForkDigest> {
    const state = await this.getHeadState();
    return computeForkDigest(this.config, state.fork.currentVersion, state.genesisValidatorsRoot);
  }

  // If we don't have a state yet, we have to wait for genesis state
  private async waitForState(): Promise<TreeBacked<BeaconState>> {
    let state = await this.db.stateArchive.lastValue();
    if (!state) {
      this.logger.info("Chain not started, listening for genesis block");
      const builder = new GenesisBuilder(this.config, {
        eth1Provider: this.eth1Provider,
        logger: this.logger,
        signal: this.abortController?.signal,
      });
      const genesisResult = await builder.waitForGenesis();
      state = genesisResult.state;
      await this.initializeBeaconChain(state as TreeBacked<BeaconState>);
    }
    // set metrics based on beacon state
    this.metrics.currentSlot.set(state.slot);
    this.metrics.previousJustifiedEpoch.set(state.previousJustifiedCheckpoint.epoch);
    this.metrics.currentJustifiedEpoch.set(state.currentJustifiedCheckpoint.epoch);
    this.metrics.currentFinalizedEpoch.set(state.finalizedCheckpoint.epoch);
    return this.config.types.BeaconState.tree.createValue(state);
  }

  private onCheckpoint = (): void => {
    this.db.stateCache.prune();
  };

  private onClockEpoch = (): void => {
    this.forkChoice.onTick();
  };
}
