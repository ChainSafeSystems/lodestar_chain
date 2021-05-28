import {computeEpochAtSlot, computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {CachedBeaconState, prepareEpochProcessState} from "@chainsafe/lodestar-beacon-state-transition/lib/allForks";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IBlockSummary} from "@chainsafe/lodestar-fork-choice";
import {allForks, Epoch, Slot} from "@chainsafe/lodestar-types";
import {BeaconBlock} from "@chainsafe/lodestar-types/lib/allForks";
import {Checkpoint} from "@chainsafe/lodestar-types/phase0";
import {ILogger, mapValues} from "@chainsafe/lodestar-utils";
import {BeaconNode} from "../nodejs";
import {ChainEvent} from "../../chain";
import {linspace} from "../../util/numpy";

/* eslint-disable no-console */

export function simTestInfoTracker(bn: BeaconNode, logger: ILogger): () => void {
  let lastSeenEpoch = 0;

  const attestationsPerBlock = new Map<Slot, number>();
  const inclusionDelayPerBlock = new Map<Slot, number>();
  const prevParticipationPerEpoch = new Map<Epoch, number>();
  const currParticipationPerEpoch = new Map<Epoch, number>();

  async function onHead(head: IBlockSummary): Promise<void> {
    const slot = head.slot;

    // For each block
    // Check if there was a proposed block and how many attestations it includes
    const block = await bn.chain.getCanonicalBlockAtSlot(head.slot);
    if (block) {
      const bits = sumAttestationBits(block.message);
      const inclDelay = avgInclusionDelay(block.message);
      attestationsPerBlock.set(slot, bits);
      inclusionDelayPerBlock.set(slot, inclDelay);
      logger.info("> Block attestations", {slot, bits, inclDelay});
    }
  }

  function logParticipation(state: CachedBeaconState<allForks.BeaconState>): void {
    // Compute participation (takes 5ms with 64 validators)
    // Need a CachedBeaconState<allForks.BeaconState> where (state.slot + 1) % SLOTS_EPOCH == 0
    const process = prepareEpochProcessState(state);
    const epoch = computeEpochAtSlot(bn.config, state.slot);

    const prevParticipation = Number(process.prevEpochUnslashedStake.targetStake) / Number(process.totalActiveStake);
    const currParticipation = Number(process.currEpochUnslashedTargetStake) / Number(process.totalActiveStake);
    prevParticipationPerEpoch.set(epoch - 1, prevParticipation);
    currParticipationPerEpoch.set(epoch, currParticipation);
    logger.info("> Participation", {
      slot: `${state.slot}/${computeEpochAtSlot(bn.config, state.slot)}`,
      prev: prevParticipation,
      curr: currParticipation,
    });
  }

  async function onCheckpoint(checkpoint: Checkpoint): Promise<void> {
    // Skip epochs on duplicated checkpoint events
    if (checkpoint.epoch <= lastSeenEpoch) return;
    lastSeenEpoch = checkpoint.epoch;

    // Recover the pre-epoch transition state
    const checkpointState = await bn.chain.regen.getCheckpointState(checkpoint);
    const lastSlot = computeStartSlotAtEpoch(bn.config, checkpoint.epoch) - 1;
    const lastStateRoot = checkpointState.stateRoots[lastSlot % bn.config.params.SLOTS_PER_HISTORICAL_ROOT];
    const lastState = await bn.chain.regen.getState(lastStateRoot);
    logParticipation(lastState);
  }

  bn.chain.emitter.on(ChainEvent.forkChoiceHead, onHead);
  bn.chain.emitter.on(ChainEvent.checkpoint, onCheckpoint);

  return function stop() {
    bn.chain.emitter.off(ChainEvent.forkChoiceHead, onHead);
    bn.chain.emitter.off(ChainEvent.checkpoint, onCheckpoint);

    // Write report
    console.log("\nEnd of sim test report\n");
    printEpochSlotGrid(attestationsPerBlock, bn.config, "Attestations per block");
    printEpochSlotGrid(inclusionDelayPerBlock, bn.config, "Inclusion delay per block");
    printEpochGrid({curr: currParticipationPerEpoch, prev: prevParticipationPerEpoch}, "Participation per epoch");
  };
}

function sumAttestationBits(block: BeaconBlock): number {
  return Array.from(block.body.attestations).reduce(
    (total, att) => total + Array.from(att.aggregationBits).filter(Boolean).length,
    0
  );
}

function avgInclusionDelay(block: BeaconBlock): number {
  const inclDelay = Array.from(block.body.attestations).map((att) => block.slot - att.data.slot);
  return avg(inclDelay);
}

function avg(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((p, c) => p + c, 0) / arr.length;
}

/**
 * Print a table grid of (Y) epoch / (X) slot_per_epoch
 */
function printEpochSlotGrid<T>(map: Map<Slot, T>, config: IBeaconConfig, title: string): void {
  const lastSlot = Array.from(map.keys())[map.size - 1];
  const lastEpoch = computeEpochAtSlot(config, lastSlot);
  const rowsByEpochBySlot = linspace(0, lastEpoch).map((epoch) => {
    const slots = linspace(epoch * config.params.SLOTS_PER_EPOCH, (epoch + 1) * config.params.SLOTS_PER_EPOCH - 1);
    return slots.map((slot) => formatValue(map.get(slot)));
  });
  console.log(renderTitle(title));
  console.table(rowsByEpochBySlot);
}

/**
 * Print a table grid of (Y) maps object key / (X) epoch
 */
function printEpochGrid(maps: Record<string, Map<Epoch, number>>, title: string): void {
  const lastEpoch = Object.values(maps).reduce((max, map) => {
    const epoch = Array.from(map.keys())[map.size - 1];
    return epoch > max ? epoch : max;
  }, 0);
  const epochGrid = linspace(0, lastEpoch).map((epoch) =>
    mapValues(maps, (val, key) => formatValue(maps[key].get(epoch)))
  );
  console.log(renderTitle(title));
  console.table(epochGrid);
}

function renderTitle(title: string): string {
  return `${title}\n${"=".repeat(title.length)}`;
}

/** Represent undefined values as "-" to make the tables shorter. The word "undefined" is too wide */
function formatValue<T>(val: T | undefined): T | string {
  return val === undefined ? "-" : val;
}
