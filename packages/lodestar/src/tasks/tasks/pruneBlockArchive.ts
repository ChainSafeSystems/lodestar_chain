/**
 * @module tasks
 */

import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition/src/util/epoch";
import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {GENESIS_EPOCH} from "@chainsafe/lodestar-params";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconClock} from "../../chain";
import {getMinEpochForBlockRequests} from "../../constants";
import {IBeaconDb} from "../../db";
import {ITask} from "../interface";
export interface IPruneBlockArchiveModules {
  db: IBeaconDb;
  clock: IBeaconClock;
  logger: ILogger;
}

/**
 * Since we only need to serve MIN_EPOCHS_FOR_BLOCK_REQUESTS of history blocks.
 * We can delete it periodically.
 */
export class PruneBlockArchiveTask implements ITask {
  private readonly config: IChainForkConfig;
  private readonly db: IBeaconDb;
  private readonly clock: IBeaconClock;
  private readonly logger: ILogger;
  private readonly maxEpochForBlockRequests: number;

  constructor(config: IChainForkConfig, modules: IPruneBlockArchiveModules) {
    this.config = config;
    this.db = modules.db;
    this.logger = modules.logger;
    this.clock = modules.clock;
    this.maxEpochForBlockRequests = getMinEpochForBlockRequests(this.config);
  }

  /**
   * Only archive blocks on the same chain to the finalized checkpoint.
   */
  async run(): Promise<void> {
    const currentEpoch = this.clock.currentEpoch;
    //prune from genesis till toEpoch
    const toEpoch = Math.max(GENESIS_EPOCH, currentEpoch - this.maxEpochForBlockRequests);
    this.logger.info("Started prunning block archive", {toEpoch});
    const slotsToDelete = await this.db.blockArchive.keys({lt: computeStartSlotAtEpoch(toEpoch)});
    await this.db.blockArchive.batchDelete(slotsToDelete);
    this.logger.info("Block archive prunning completed!", {
      firstSlotDeleted: slotsToDelete[0],
      lastSlotDeleted: slotsToDelete[slotsToDelete.length - 1] ?? null,
    });
  }
}
