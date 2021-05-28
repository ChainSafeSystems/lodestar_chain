import fs from "fs";
import path from "path";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {allForks, phase0} from "@chainsafe/lodestar-types";
import {interopDeposits} from "./interop/deposits";
import {getInteropStateFromDeposits} from "./interop/state";
import {IBeaconDb} from "../../db";
import {TreeBacked} from "@chainsafe/ssz";

export async function getInteropState(
  config: IBeaconConfig,
  validatorCount: number,
  genesisTime?: number
): Promise<{state: TreeBacked<allForks.BeaconState>; deposits: phase0.Deposit[]}> {
  const deposits = interopDeposits(config, config.types.phase0.DepositDataRootList.defaultTreeBacked(), validatorCount);

  const state = getInteropStateFromDeposits(config, genesisTime || Math.floor(Date.now() / 1000), deposits);
  return {state, deposits};
}

export async function storeSSZState(
  config: IBeaconConfig,
  state: TreeBacked<allForks.BeaconState>,
  filepath: string
): Promise<void> {
  fs.mkdirSync(path.dirname(filepath), {recursive: true});
  await fs.promises.writeFile(filepath, config.getForkTypes(state.slot).BeaconState.serialize(state));
}

export async function storeDeposits(config: IBeaconConfig, db: IBeaconDb, deposits: phase0.Deposit[]): Promise<void> {
  for (let i = 0; i < deposits.length; i++) {
    await Promise.all([
      db.depositEvent.put(i, {
        blockNumber: i,
        index: i,
        depositData: deposits[i].data,
      }),
      db.depositDataRoot.put(i, config.types.phase0.DepositData.hashTreeRoot(deposits[i].data)),
    ]);
  }
}
