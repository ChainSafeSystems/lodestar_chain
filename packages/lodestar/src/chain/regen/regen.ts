import {phase0, Root, Slot} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {
  CachedBeaconState,
  computeEpochAtSlot,
  computeStartSlotAtEpoch,
} from "@chainsafe/lodestar-beacon-state-transition";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";

import {CheckpointStateCache, StateContextCache} from "../stateCache";
import {ChainEventEmitter} from "../emitter";
import {IBeaconDb} from "../../db";
import {processSlotsByCheckpoint, runStateTransition} from "../blocks/stateTransition";
import {IStateRegenerator} from "./interface";
import {RegenError, RegenErrorCode} from "./errors";

/**
 * Regenerates states that have already been processed by the fork choice
 */
export class StateRegenerator implements IStateRegenerator {
  private config: IBeaconConfig;
  private emitter: ChainEventEmitter;
  private forkChoice: IForkChoice;
  private stateCache: StateContextCache;
  private checkpointStateCache: CheckpointStateCache;
  private db: IBeaconDb;

  constructor({
    config,
    emitter,
    forkChoice,
    stateCache,
    checkpointStateCache,
    db,
  }: {
    config: IBeaconConfig;
    emitter: ChainEventEmitter;
    forkChoice: IForkChoice;
    stateCache: StateContextCache;
    checkpointStateCache: CheckpointStateCache;
    db: IBeaconDb;
  }) {
    this.config = config;
    this.emitter = emitter;
    this.forkChoice = forkChoice;
    this.stateCache = stateCache;
    this.checkpointStateCache = checkpointStateCache;
    this.db = db;
  }

  async getPreState(block: phase0.BeaconBlock): Promise<CachedBeaconState<phase0.BeaconState>> {
    const parentBlock = this.forkChoice.getBlock(block.parentRoot);
    if (!parentBlock) {
      throw new RegenError({
        code: RegenErrorCode.BLOCK_NOT_IN_FORKCHOICE,
        blockRoot: block.parentRoot,
      });
    }

    const parentEpoch = computeEpochAtSlot(this.config, parentBlock.slot);
    const blockEpoch = computeEpochAtSlot(this.config, block.slot);

    // If the requested state crosses an epoch boundary and the block isn't a checkpoint block
    // then we may use the checkpoint state before the block. This may save us at least one epoch transition.
    const isCheckpointBlock = block.slot % this.config.params.SLOTS_PER_EPOCH === 0;
    if (parentEpoch < blockEpoch && !isCheckpointBlock) {
      return await this.getCheckpointState({root: block.parentRoot, epoch: blockEpoch});
    }

    // If there's more than one epoch to pre-process (but the block is a checkpoint block)
    // get the checkpoint state as close as possible
    if (parentEpoch < blockEpoch - 1) {
      return await this.getCheckpointState({root: block.parentRoot, epoch: blockEpoch - 1});
    }

    // Otherwise, get the state normally.
    return await this.getState(parentBlock.stateRoot);
  }

  async getCheckpointState(cp: phase0.Checkpoint): Promise<CachedBeaconState<phase0.BeaconState>> {
    const checkpointStartSlot = computeStartSlotAtEpoch(this.config, cp.epoch);
    return await this.getBlockSlotState(cp.root, checkpointStartSlot);
  }

  async getBlockSlotState(blockRoot: Root, slot: Slot): Promise<CachedBeaconState<phase0.BeaconState>> {
    const block = this.forkChoice.getBlock(blockRoot);
    if (!block) {
      throw new RegenError({
        code: RegenErrorCode.BLOCK_NOT_IN_FORKCHOICE,
        blockRoot,
      });
    }

    if (slot < block.slot) {
      throw new RegenError({
        code: RegenErrorCode.SLOT_BEFORE_BLOCK_SLOT,
        slot,
        blockSlot: block.slot,
      });
    }

    const latestCheckpointStateCtx = this.checkpointStateCache.getLatest({
      root: blockRoot,
      epoch: computeEpochAtSlot(this.config, slot),
    });

    // If a checkpoint state exists with the given checkpoint root, it either is in requested epoch
    // or needs to have empty slots processed until the requested epoch
    if (latestCheckpointStateCtx) {
      return await processSlotsByCheckpoint(this.emitter, latestCheckpointStateCtx, slot);
    }

    // Otherwise, use the fork choice to get the stateRoot from block at the checkpoint root
    // regenerate that state,
    // then process empty slots until the requested epoch
    const blockStateCtx = await this.getState(block.stateRoot);
    return await processSlotsByCheckpoint(this.emitter, blockStateCtx, slot);
  }

  async getState(stateRoot: Root): Promise<CachedBeaconState<phase0.BeaconState>> {
    // Trivial case, state at stateRoot is already cached
    const cachedStateCtx = this.stateCache.get(stateRoot);
    if (cachedStateCtx) {
      return cachedStateCtx;
    }

    // Otherwise we have to use the fork choice to traverse backwards, block by block,
    // searching the state caches
    // then replay blocks forward to the desired stateRoot
    const rootType = this.config.types.Root;
    const block = this.forkChoice
      .forwardIterateBlockSummaries()
      .find((summary) => rootType.equals(summary.stateRoot, stateRoot));

    if (!block) {
      throw new RegenError({
        code: RegenErrorCode.STATE_NOT_IN_FORKCHOICE,
        stateRoot,
      });
    }

    // blocks to replay, ordered highest to lowest
    // gets reversed when replayed
    const blocksToReplay = [block];
    let state: CachedBeaconState<phase0.BeaconState> | null = null;
    for (const b of this.forkChoice.iterateBlockSummaries(block.parentRoot)) {
      state = this.stateCache.get(b.stateRoot);
      if (state) {
        break;
      }
      state = this.checkpointStateCache.getLatest({
        root: b.blockRoot,
        epoch: computeEpochAtSlot(this.config, blocksToReplay[blocksToReplay.length - 1].slot - 1),
      });
      if (state) {
        break;
      }
      blocksToReplay.push(b);
    }

    if (state === null) {
      throw new RegenError({
        code: RegenErrorCode.NO_SEED_STATE,
      });
    }

    const MAX_EPOCH_TO_PROCESS = 5;
    if (blocksToReplay.length > MAX_EPOCH_TO_PROCESS * this.config.params.SLOTS_PER_EPOCH) {
      throw new RegenError({
        code: RegenErrorCode.TOO_MANY_BLOCK_PROCESSED,
        stateRoot,
      });
    }

    for (const b of blocksToReplay.reverse()) {
      const block = await this.db.block.get(b.blockRoot);
      if (!block) {
        throw new RegenError({
          code: RegenErrorCode.BLOCK_NOT_IN_DB,
          blockRoot: b.blockRoot,
        });
      }

      try {
        state = await runStateTransition(this.emitter, this.forkChoice, this.checkpointStateCache, state, {
          signedBlock: block,
          reprocess: true,
          prefinalized: true,
          validSignatures: true,
          validProposerSignature: true,
        });
      } catch (e: unknown) {
        throw new RegenError({
          code: RegenErrorCode.STATE_TRANSITION_ERROR,
          error: e,
        });
      }
    }

    return state as CachedBeaconState<phase0.BeaconState>;
  }
}
