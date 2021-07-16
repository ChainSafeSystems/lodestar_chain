import {Options} from "yargs";
import {ICliCommandOptions} from "../../util";
import {beaconOptions, IBeaconArgs} from "../beacon/options";
import {globalOptions, beaconNodeOptions} from "../../options";
import {validatorOptions, IValidatorCliArgs} from "../validator/options";

interface IDevOwnArgs {
  genesisValidators?: number;
  startValidators?: string;
  genesisTime?: number;
  reset?: boolean;
  server: string;
}

const devOwnOptions: ICliCommandOptions<IDevOwnArgs> = {
  genesisValidators: {
    alias: ["c"],
    description: "If present it will create genesis with interop validators and start chain.",
    type: "number",
    group: "dev",
  },

  startValidators: {
    description: "Start interop validators in given range",
    default: "0:8",
    type: "string",
    group: "dev",
  },

  genesisTime: {
    description: "genesis_time to initialize interop genesis state",
    type: "number",
    group: "dev",
  },

  reset: {
    description: "To delete chain and validator directories",
    alias: ["r"],
    type: "boolean",
    group: "dev",
  },

  server: {
    description: "Address to connect to BeaconNode. Pass 'memory' for in memory communication",
    default: "http://127.0.0.1:9596",
    type: "string",
  },
};

/**
 * Add custom defaults different than the ones in `beaconOptions`:
 * - In dev command we don't wanna connect to other peers,
 * - but we do wanna get out of syncing (min peers)
 * - and have api enabled by default (as it's used by validator)
 * Note: use beaconNodeOptions and globalOptions to make sure option key is correct
 */
const externalOptionsOverrides: {[k: string]: Options} = {
  "sync.isSingleNode": {
    ...beaconNodeOptions["sync.isSingleNode"],
    defaultDescription: undefined,
    default: true,
  },
  "network.maxPeers": {
    ...beaconNodeOptions["network.maxPeers"],
    defaultDescription: undefined,
    default: 1,
  },
  "network.targetPeers": {
    ...beaconNodeOptions["network.targetPeers"],
    defaultDescription: undefined,
    default: 1,
  },
  "eth1.enabled": {
    ...beaconNodeOptions["eth1.enabled"],
    defaultDescription: undefined,
    default: false,
  },
  "api.rest.enabled": {
    ...beaconNodeOptions["api.rest.enabled"],
    defaultDescription: undefined,
    default: true,
  },
  preset: {
    ...globalOptions.preset,
    default: "minimal",
  },
};

export const devOptions = {
  ...beaconOptions,
  ...validatorOptions,
  ...externalOptionsOverrides,
  ...devOwnOptions,
};

export type IDevArgs = IBeaconArgs & IValidatorCliArgs & IDevOwnArgs;
