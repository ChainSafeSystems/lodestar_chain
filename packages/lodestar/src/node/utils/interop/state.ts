import {TreeBacked} from "@chainsafe/ssz";
import {allForks, phase0} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {initializeBeaconStateFromEth1} from "@chainsafe/lodestar-beacon-state-transition";

const INTEROP_BLOCK_HASH = Buffer.alloc(32, "B");
const INTEROP_TIMESTAMP = Math.pow(2, 40);

export function getInteropStateFromDeposits(
  config: IBeaconConfig,
  genesisTime: number,
  deposits: phase0.Deposit[]
): TreeBacked<allForks.BeaconState> {
  const state = initializeBeaconStateFromEth1(config, INTEROP_BLOCK_HASH, INTEROP_TIMESTAMP, deposits);
  state.genesisTime = genesisTime;
  return state;
}
