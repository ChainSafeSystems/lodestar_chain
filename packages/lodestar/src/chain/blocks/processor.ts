import {AbortSignal} from "abort-controller";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";
import {phase0} from "@chainsafe/lodestar-types";

import {IBlockJob, IChainSegmentJob} from "../interface";
import {ChainEvent, ChainEventEmitter} from "../emitter";
import {IBeaconClock} from "../clock";
import {IStateRegenerator} from "../regen";
import {JobQueue} from "../../util/queue";
import {CheckpointStateCache} from "../stateCache";
import {BlockError, BlockErrorCode, ChainSegmentError} from "../errors";
import {IBeaconMetrics} from "../../metrics";

import {processBlock, processChainSegment} from "./process";
import {validateBlock} from "./validate";

type BlockProcessorModules = {
  config: IBeaconConfig;
  forkChoice: IForkChoice;
  regen: IStateRegenerator;
  emitter: ChainEventEmitter;
  metrics?: IBeaconMetrics;
  clock: IBeaconClock;
  checkpointStateCache: CheckpointStateCache;
};

/**
 * BlockProcessor processes block jobs in a queued fashion, one after the other.
 */
export class BlockProcessor {
  private modules: BlockProcessorModules;
  private jobQueue: JobQueue;

  constructor({
    signal,
    queueSize = 256,
    ...modules
  }: BlockProcessorModules & {
    signal: AbortSignal;
    queueSize?: number;
  }) {
    this.modules = modules;
    this.jobQueue = new JobQueue({queueSize, signal, onJobDone: this.onJobDone});
  }

  async processBlockJob(job: IBlockJob): Promise<void> {
    return await this.jobQueue.enqueueJob(async () => await processBlockJob(this.modules, job));
  }

  async processChainSegment(job: IChainSegmentJob): Promise<void> {
    return await this.jobQueue.enqueueJob(async () => await processChainSegmentJob(this.modules, job));
  }

  private onJobDone = ({ms}: {ms: number}): void => {
    this.modules.metrics?.blockProcessorTotalAsyncTime.inc(ms / 1000);
  };
}

/**
 * Validate and process a block
 *
 * The only effects of running this are:
 * - forkChoice update, in the case of a valid block
 * - various events emitted: checkpoint, forkChoice:*, head, block, error:block
 * - (state cache update, from state regeneration)
 *
 * All other effects are provided by downstream event handlers
 */
export async function processBlockJob(modules: BlockProcessorModules, job: IBlockJob): Promise<void> {
  try {
    validateBlock({...modules, job});
    await processBlock({...modules, job});
  } catch (e: unknown) {
    // above functions only throw BlockError
    modules.emitter.emit(ChainEvent.errorBlock, e);
  }
}

/**
 * Similar to processBlockJob but this process a chain segment
 */
export async function processChainSegmentJob(modules: BlockProcessorModules, job: IChainSegmentJob): Promise<void> {
  const blocks = job.signedBlocks;

  // Validate and filter out irrelevant blocks
  const filteredChainSegment: phase0.SignedBeaconBlock[] = [];
  for (const [i, block] of blocks.entries()) {
    const child = blocks[i + 1];
    if (child) {
      // If this block has a child in this chain segment, ensure that its parent root matches
      // the root of this block.
      //
      // Without this check it would be possible to have a block verified using the
      // incorrect shuffling. That would be bad, mmkay.
      if (
        !modules.config.types.Root.equals(
          modules.config.types.phase0.BeaconBlock.hashTreeRoot(block.message),
          child.message.parentRoot
        )
      ) {
        throw new ChainSegmentError({
          code: BlockErrorCode.NON_LINEAR_PARENT_ROOTS,
          job,
          importedBlocks: 0,
        });
      }
      // Ensure that the slots are strictly increasing throughout the chain segment.
      if (child.message.slot <= block.message.slot) {
        throw new ChainSegmentError({
          code: BlockErrorCode.NON_LINEAR_SLOTS,
          job,
          importedBlocks: 0,
        });
      }
    }

    try {
      validateBlock({...modules, job: {...job, signedBlock: block}});
      // If the block is relevant, add it to the filtered chain segment.
      filteredChainSegment.push(block);
    } catch (e: unknown) {
      switch ((e as BlockError).type.code) {
        // If the block is already known, simply ignore this block.
        case BlockErrorCode.BLOCK_IS_ALREADY_KNOWN:
          continue;
        // If the block is the genesis block, simply ignore this block.
        case BlockErrorCode.GENESIS_BLOCK:
          continue;
        // If the block is is for a finalized slot, simply ignore this block.
        //
        // The block is either:
        //
        // 1. In the canonical finalized chain.
        // 2. In some non-canonical chain at a slot that has been finalized already.
        //
        // In the case of (1), there's no need to re-import and later blocks in this
        // segement might be useful.
        //
        // In the case of (2), skipping the block is valid since we should never import it.
        // However, we will potentially get a `ParentUnknown` on a later block. The sync
        // protocol will need to ensure this is handled gracefully.
        case BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT:
          continue;
        // Any other error whilst determining if the block was invalid, return that
        // error.
        default:
          throw new ChainSegmentError({
            job: e.job,
            ...e.type,
            importedBlocks: 0,
          });
      }
    }
  }

  await processChainSegment({
    ...modules,
    job: {
      ...job,
      signedBlocks: filteredChainSegment,
    },
  });
}
