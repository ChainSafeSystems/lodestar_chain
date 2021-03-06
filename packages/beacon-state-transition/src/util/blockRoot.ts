/**
 * @module chain/stateTransition/util
 */

import {Epoch, Slot, Root, phase0, allForks} from "@chainsafe/lodestar-types";
import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {assert} from "@chainsafe/lodestar-utils";

import {ZERO_HASH} from "../constants";
import {computeStartSlotAtEpoch} from "./epoch";
import {SLOTS_PER_HISTORICAL_ROOT} from "@chainsafe/lodestar-params";

/**
 * Return the block root at a recent [[slot]].
 */
export function getBlockRootAtSlot(state: allForks.BeaconState, slot: Slot): Root {
  assert.lt(slot, state.slot, "Cannot get block root for slot in the future");
  assert.lte(
    state.slot,
    slot + SLOTS_PER_HISTORICAL_ROOT,
    `Cannot get block root from slot more than ${SLOTS_PER_HISTORICAL_ROOT} in the past`
  );
  return state.blockRoots[slot % SLOTS_PER_HISTORICAL_ROOT];
}

/**
 * Return the block root at the start of a recent [[epoch]].
 */
export function getBlockRoot(state: allForks.BeaconState, epoch: Epoch): Root {
  return getBlockRootAtSlot(state, computeStartSlotAtEpoch(epoch));
}
/**
 * Return the block header corresponding to a block with ``state_root`` set to ``ZERO_HASH``.
 */
export function getTemporaryBlockHeader(
  config: IChainForkConfig,
  block: allForks.BeaconBlock
): phase0.BeaconBlockHeader {
  return {
    slot: block.slot,
    proposerIndex: block.proposerIndex,
    parentRoot: block.parentRoot,
    // `state_root` is zeroed and overwritten in the next `process_slot` call
    stateRoot: ZERO_HASH,
    bodyRoot: config.getForkTypes(block.slot).BeaconBlockBody.hashTreeRoot(block.body),
  };
}

/**
 * Receives a BeaconBlock, and produces the corresponding BeaconBlockHeader.
 */
export function blockToHeader(config: IChainForkConfig, block: allForks.BeaconBlock): phase0.BeaconBlockHeader {
  return {
    stateRoot: block.stateRoot,
    proposerIndex: block.proposerIndex,
    slot: block.slot,
    parentRoot: block.parentRoot,
    bodyRoot: config.getForkTypes(block.slot).BeaconBlockBody.hashTreeRoot(block.body),
  };
}
