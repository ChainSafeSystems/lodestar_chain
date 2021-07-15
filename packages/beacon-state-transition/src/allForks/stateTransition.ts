/* eslint-disable import/namespace */
import {allForks, phase0 as phase0Types, Slot, ssz} from "@chainsafe/lodestar-types";
import {ForkName, GENESIS_EPOCH, SLOTS_PER_EPOCH} from "@chainsafe/lodestar-params";
import * as phase0 from "../phase0";
import * as altair from "../altair";
import {IBeaconStateTransitionMetrics} from "../metrics";
import {verifyProposerSignature} from "./signatureSets";
import {CachedBeaconState, IEpochProcess, rotateEpochs} from "./util";
import {processSlot} from "./slot";
import {computeEpochAtSlot} from "../util";

type StateAllForks = CachedBeaconState<allForks.BeaconState>;
type StatePhase0 = CachedBeaconState<phase0Types.BeaconState>;

type ProcessBlockFn = (state: StateAllForks, block: allForks.BeaconBlock, verifySignatures: boolean) => void;
type ProcessEpochFn = (state: StateAllForks) => IEpochProcess;

const processBlockByFork: Record<ForkName, ProcessBlockFn> = {
  [ForkName.phase0]: phase0.processBlock as ProcessBlockFn,
  [ForkName.altair]: altair.processBlock as ProcessBlockFn,
};

const processEpochByFork: Record<ForkName, ProcessEpochFn> = {
  [ForkName.phase0]: phase0.processEpoch as ProcessEpochFn,
  [ForkName.altair]: altair.processEpoch as ProcessEpochFn,
};

// Multifork capable state transition

/**
 * Implementation Note: follows the optimizations in protolambda's eth2fastspec (https://github.com/protolambda/eth2fastspec)
 */
export function stateTransition(
  state: CachedBeaconState<allForks.BeaconState>,
  signedBlock: allForks.SignedBeaconBlock,
  options?: {verifyStateRoot?: boolean; verifyProposer?: boolean; verifySignatures?: boolean},
  metrics?: IBeaconStateTransitionMetrics | null
): CachedBeaconState<allForks.BeaconState> {
  const {verifyStateRoot = true, verifyProposer = true} = options || {};

  const block = signedBlock.message;
  const blockSlot = block.slot;

  let postState = state.clone();

  // Turn caches into a data-structure optimized for fast writes
  postState.setStateCachesAsTransient();

  // Process slots (including those with no blocks) since block.
  // Includes state upgrades
  postState = processSlotsWithTransientCache(postState, blockSlot, metrics);

  // Verify proposer signature only
  if (verifyProposer) {
    if (!verifyProposerSignature(postState, signedBlock)) {
      throw new Error("Invalid block signature");
    }
  }

  // Process block
  processBlock(postState, block, options, metrics);

  // Verify state root
  if (verifyStateRoot) {
    if (!ssz.Root.equals(block.stateRoot, postState.tree.root)) {
      throw new Error("Invalid state root");
    }
  }

  // Turn caches into a data-structure optimized for hashing and structural sharing
  postState.setStateCachesAsPersistent();

  return postState;
}

/**
 * Multifork capable processBlock()
 *
 * Implementation Note: follows the optimizations in protolambda's eth2fastspec (https://github.com/protolambda/eth2fastspec)
 */
export function processBlock(
  postState: CachedBeaconState<allForks.BeaconState>,
  block: allForks.BeaconBlock,
  options?: {verifySignatures?: boolean},
  metrics?: IBeaconStateTransitionMetrics | null
): void {
  const {verifySignatures = true} = options || {};
  const fork = postState.config.getForkName(block.slot);

  const timer = metrics?.stfnProcessBlock.startTimer();
  try {
    processBlockByFork[fork](postState, block, verifySignatures);
  } finally {
    if (timer) timer();
  }
}

/**
 * Like `processSlots` from the spec but additionally handles fork upgrades
 *
 * Implementation Note: follows the optimizations in protolambda's eth2fastspec (https://github.com/protolambda/eth2fastspec)
 */
export function processSlots(
  state: CachedBeaconState<allForks.BeaconState>,
  slot: Slot,
  metrics?: IBeaconStateTransitionMetrics | null
): CachedBeaconState<allForks.BeaconState> {
  let postState = state.clone();

  // Turn caches into a data-structure optimized for fast writes
  postState.setStateCachesAsTransient();

  postState = processSlotsWithTransientCache(postState, slot, metrics);

  // Turn caches into a data-structure optimized for hashing and structural sharing
  postState.setStateCachesAsPersistent();

  return postState;
}

/**
 * All processSlot() logic but separate so stateTransition() can recycle the caches
 */
function processSlotsWithTransientCache(
  postState: StateAllForks,
  slot: Slot,
  metrics?: IBeaconStateTransitionMetrics | null
): StateAllForks {
  const {config} = postState;
  if (postState.slot > slot) {
    throw Error(`Too old slot ${slot}, current=${postState.slot}`);
  }

  while (postState.slot < slot) {
    processSlot(postState);

    // Process epoch on the first slot of the next epoch
    if ((postState.slot + 1) % SLOTS_PER_EPOCH === 0) {
      // At fork boundary we don't want to process "next fork" epoch before upgrading state
      const fork = postState.config.getForkName(postState.slot);
      const timer = metrics?.stfnEpochTransition.startTimer();
      try {
        const process = processEpochByFork[fork](postState);
        metrics?.registerValidatorStatuses(process.currentEpoch, process.statuses);

        postState.slot++;
        rotateEpochs(postState.epochCtx, postState, process.indicesBounded);
      } finally {
        if (timer) timer();
      }

      // Upgrade state if exactly at epoch boundary
      switch (computeEpochAtSlot(postState.slot)) {
        case GENESIS_EPOCH:
          break; // Don't do any upgrades at genesis epoch
        case config.ALTAIR_FORK_EPOCH:
          postState = altair.upgradeState(postState as StatePhase0) as StateAllForks;
          break;
      }
    } else {
      postState.slot++;
    }
  }

  return postState;
}
