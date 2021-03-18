import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IBeaconChain, IBlockJob} from "..";
import {IBeaconDb} from "../../db/api";
import {ValidatorIndex} from "@chainsafe/lodestar-types";
import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {phase0} from "@chainsafe/lodestar-beacon-state-transition";
import {BlockError, BlockErrorCode} from "../errors";

export async function validateGossipBlock(
  config: IBeaconConfig,
  chain: IBeaconChain,
  db: IBeaconDb,
  blockJob: IBlockJob
): Promise<void> {
  const block = blockJob.signedBlock;
  const blockSlot = block.message.slot;
  const blockRoot = config.types.phase0.BeaconBlock.hashTreeRoot(block.message);
  const finalizedCheckpoint = chain.getFinalizedCheckpoint();
  const finalizedSlot = computeStartSlotAtEpoch(config, finalizedCheckpoint.epoch);
  // block is too old
  if (blockSlot <= finalizedSlot) {
    throw new BlockError({
      code: BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT,
      blockSlot,
      finalizedSlot,
      job: blockJob,
    });
  }

  const currentSlotWithGossipDisparity = chain.clock.currentSlotWithGossipDisparity;
  if (currentSlotWithGossipDisparity < blockSlot) {
    throw new BlockError({
      code: BlockErrorCode.FUTURE_SLOT,
      currentSlot: currentSlotWithGossipDisparity,
      blockSlot,
      job: blockJob,
    });
  }

  if (await db.badBlock.has(blockRoot)) {
    throw new BlockError({
      code: BlockErrorCode.KNOWN_BAD_BLOCK,
      job: blockJob,
    });
  }

  if (await hasProposerAlreadyProposed(db, blockRoot, block.message.proposerIndex)) {
    throw new BlockError({
      code: BlockErrorCode.REPEAT_PROPOSAL,
      proposer: block.message.proposerIndex,
      job: blockJob,
    });
  }

  let blockState;
  try {
    // getBlockSlotState also checks for whether the current finalized checkpoint is an ancestor of the block.  as a result, we throw an IGNORE (whereas the spec says we should REJECT for this scenario).  this is something we should change this in the future to make the code airtight to the spec.
    blockState = await chain.regen.getBlockSlotState(block.message.parentRoot, block.message.slot);
  } catch (e: unknown) {
    throw new BlockError({
      code: BlockErrorCode.PARENT_UNKNOWN,
      parentRoot: block.message.parentRoot,
      job: blockJob,
    });
  }

  if (!phase0.fast.verifyBlockSignature(blockState, block)) {
    throw new BlockError({
      code: BlockErrorCode.PROPOSAL_SIGNATURE_INVALID,
      job: blockJob,
    });
  }

  try {
    const validProposer = isExpectedProposer(blockState.epochCtx, block.message);
    if (!validProposer) {
      throw new BlockError({
        code: BlockErrorCode.INCORRECT_PROPOSER,
        blockProposer: block.message.proposerIndex,
        job: blockJob,
      });
    }
  } catch (error) {
    throw new BlockError({
      code: BlockErrorCode.INCORRECT_PROPOSER,
      blockProposer: block.message.proposerIndex,
      job: blockJob,
    });
  }
}

export async function hasProposerAlreadyProposed(
  db: IBeaconDb,
  blockRoot: Uint8Array,
  proposerIndex: ValidatorIndex
): Promise<boolean> {
  const existingBlock = await db.block.get(blockRoot);
  return existingBlock?.message.proposerIndex === proposerIndex;
}

export function isExpectedProposer(epochCtx: phase0.fast.EpochContext, block: phase0.BeaconBlock): boolean {
  const supposedProposerIndex = epochCtx.getBeaconProposer(block.slot);
  return supposedProposerIndex === block.proposerIndex;
}
