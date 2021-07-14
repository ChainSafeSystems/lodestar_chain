import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {IBeaconChain, IBlockJob} from "..";
import {IBeaconDb} from "../../db";
import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {allForks} from "@chainsafe/lodestar-beacon-state-transition";
import {BlockGossipError, BlockErrorCode, GossipAction} from "../errors";

export async function validateGossipBlock(
  config: IChainForkConfig,
  chain: IBeaconChain,
  db: IBeaconDb,
  blockJob: IBlockJob
): Promise<void> {
  const block = blockJob.signedBlock;
  const blockSlot = block.message.slot;
  const blockRoot = config.getForkTypes(block.message.slot).BeaconBlock.hashTreeRoot(block.message);
  const finalizedCheckpoint = chain.getFinalizedCheckpoint();
  const finalizedSlot = computeStartSlotAtEpoch(finalizedCheckpoint.epoch);
  // block is too old
  if (blockSlot <= finalizedSlot) {
    throw new BlockGossipError(GossipAction.IGNORE, {
      code: BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT,
      blockSlot,
      finalizedSlot,
    });
  }

  const currentSlotWithGossipDisparity = chain.clock.currentSlotWithGossipDisparity;
  if (currentSlotWithGossipDisparity < blockSlot) {
    throw new BlockGossipError(GossipAction.IGNORE, {
      code: BlockErrorCode.FUTURE_SLOT,
      currentSlot: currentSlotWithGossipDisparity,
      blockSlot,
    });
  }

  // No need to check for badBlock
  // Gossip de-duplicates messages so we shouldn't be able to receive a bad block twice

  const existingBlock = await db.block.get(blockRoot);
  if (existingBlock?.message.proposerIndex === block.message.proposerIndex) {
    throw new BlockGossipError(GossipAction.IGNORE, {
      code: BlockErrorCode.REPEAT_PROPOSAL,
      proposer: block.message.proposerIndex,
    });
  }

  // getBlockSlotState also checks for whether the current finalized checkpoint is an ancestor of the block.  as a result, we throw an IGNORE (whereas the spec says we should REJECT for this scenario).  this is something we should change this in the future to make the code airtight to the spec.
  const blockState = await chain.regen.getBlockSlotState(block.message.parentRoot, block.message.slot).catch(() => {
    throw new BlockGossipError(GossipAction.IGNORE, {
      code: BlockErrorCode.PARENT_UNKNOWN,
      parentRoot: block.message.parentRoot.valueOf() as Uint8Array,
    });
  });

  const signatureSet = allForks.getProposerSignatureSet(blockState, block);
  // Don't batch so verification is not delayed
  if (!(await chain.bls.verifySignatureSets([signatureSet]))) {
    throw new BlockGossipError(GossipAction.REJECT, {code: BlockErrorCode.PROPOSAL_SIGNATURE_INVALID});
  }

  try {
    const validProposer = isExpectedProposer(blockState.epochCtx, block.message);
    if (!validProposer) {
      throw Error("INCORRECT_PROPOSER");
    }
  } catch (error) {
    throw new BlockGossipError(GossipAction.REJECT, {
      code: BlockErrorCode.INCORRECT_PROPOSER,
      blockProposer: block.message.proposerIndex,
    });
  }
}

export function isExpectedProposer(epochCtx: allForks.EpochContext, block: allForks.BeaconBlock): boolean {
  const supposedProposerIndex = epochCtx.getBeaconProposer(block.slot);
  return supposedProposerIndex === block.proposerIndex;
}
