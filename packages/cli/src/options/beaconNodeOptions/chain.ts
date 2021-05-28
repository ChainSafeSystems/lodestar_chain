import {defaultOptions, IBeaconNodeOptions} from "@chainsafe/lodestar";
import {ICliCommandOptions} from "../../util";

export interface IChainArgs {
  "chain.useSingleThreadVerifier": boolean;
  "chain.runChainStatusNotifier": boolean;
}

export function parseArgs(args: IChainArgs): IBeaconNodeOptions["chain"] {
  return {
    useSingleThreadVerifier: args["chain.useSingleThreadVerifier"],
    runChainStatusNotifier: args["chain.runChainStatusNotifier"],
  };
}

export const options: ICliCommandOptions<IChainArgs> = {
  "chain.useSingleThreadVerifier": {
    hidden: true,
    type: "boolean",
    description: "Disable spawning worker threads for BLS verification, use single thread implementation.",
    defaultDescription: String(defaultOptions.chain.useSingleThreadVerifier),
    group: "chain",
  },

  "chain.runChainStatusNotifier": {
    hidden: true,
    type: "boolean",
    description: "Run chain status notifier. WARNING: very expensive only run in small testnets",
    defaultDescription: String(defaultOptions.chain.runChainStatusNotifier),
    group: "chain",
  },
};
