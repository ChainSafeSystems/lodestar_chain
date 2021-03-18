import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IBeaconSync} from "../../sync";
import {ApiError} from "./errors/api";

/**
 * Check the sync status of the beacon chain.
 */
export async function checkSyncStatus(config: IBeaconConfig, sync: IBeaconSync): Promise<void> {
  if (!sync.isSynced()) {
    let syncStatus;
    try {
      syncStatus = sync.getSyncStatus();
    } catch (e: unknown) {
      throw new ApiError(503, "Node is stopped");
    }
    if (syncStatus.syncDistance > config.params.SLOTS_PER_EPOCH) {
      throw new ApiError(
        503,
        `Node is syncing, status: ${JSON.stringify(config.types.phase0.SyncingStatus.toJson(syncStatus))}`
      );
    }
  }
}
