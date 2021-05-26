import {Options} from "yargs";
import {beaconNodeOptions, paramsOptions, IBeaconNodeArgs, IENRArgs, enrOptions} from "../../options";
import {defaultBeaconPaths, IBeaconPaths} from "./paths";
import {ICliCommandOptions} from "../../util";

interface IBeaconExtraArgs {
  forceGenesis?: boolean;
  genesisStateFile?: string;
  weakSubjectivityStateFile?: string;
  weakSubjectivityServer: string;
  fetchChainSafeWeakSubjecitivtyState: boolean;
  weakSubjectivityCheckpoint?: string;
}

export const beaconExtraOptions: ICliCommandOptions<IBeaconExtraArgs> = {
  forceGenesis: {
    description: "Force beacon to create genesis without file",
    type: "boolean",
  },

  genesisStateFile: {
    description: "Path or URL to download a genesis state file in ssz-encoded format",
    type: "string",
  },

  weakSubjectivityStateFile: {
    description: "Path or URL to download a weak subjectivity state file in ssz-encoded format",
    type: "string",
  },

  fetchChainSafeWeakSubjecitivtyState: {
    description: "Tell the beacon node to fetch the latest weak subjectivity state for the given network from the ChainSafe weak subjectivity state server.",
    type: "boolean",
    default: false,
  },

  weakSubjectivityCheckpoint: {
    description: "Tell the beacon node to fetch a weak subjectivity state at the specified checkpoint.  The string arg must be in the form <blockRoot>:<epoch>.  For example, 0x1234:100 would ask for the weak subjectivity state at checkpoint of epoch 100 with block root 0x1234.",
    type: "string",
  }
};

export const beaconPathsOptions: ICliCommandOptions<IBeaconPaths> = {
  beaconDir: {
    description: "Beacon root directory",
    defaultDescription: defaultBeaconPaths.beaconDir,
    hidden: true,
    type: "string",
  },

  dbDir: {
    description: "Beacon DB directory",
    defaultDescription: defaultBeaconPaths.dbDir,
    hidden: true,
    type: "string",
  },

  configFile: {
    description: "Beacon node configuration file path",
    defaultDescription: defaultBeaconPaths.configFile,
    type: "string",
  },

  peerStoreDir: {
    hidden: true,
    description: "Peer store directory",
    defaultDescription: defaultBeaconPaths.peerStoreDir,
    type: "string",
  },

  peerIdFile: {
    hidden: true,
    description: "Peer ID file path",
    defaultDescription: defaultBeaconPaths.peerIdFile,
    type: "string",
  },

  enrFile: {
    hidden: true,
    description: "ENR file path",
    defaultDescription: defaultBeaconPaths.enrFile,
    type: "string",
  },

  logFile: {
    description: "Path to output all logs to a persistent log file",
    type: "string",
  },
};

export type IBeaconArgs = IBeaconNodeArgs & IBeaconPaths & IENRArgs & IBeaconExtraArgs;

export const beaconOptions: {[k: string]: Options} = {
  ...beaconPathsOptions,
  ...beaconExtraOptions,
  ...beaconNodeOptions,
  ...paramsOptions,
  ...enrOptions,
};
