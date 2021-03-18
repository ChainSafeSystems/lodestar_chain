import fs from "fs";
import {
  BeaconNodeOptions,
  getBeaconConfigFromArgs,
  writeBeaconParams,
  initPeerId,
  initEnr,
  readPeerId,
} from "../../config";
import {IGlobalArgs, parseBeaconNodeArgs} from "../../options";
import {mkdir} from "../../util";
import {fetchBootnodes} from "../../networks";
import {getBeaconPaths} from "../beacon/paths";
import {IBeaconArgs} from "../beacon/options";
import {IBeaconConfig} from "@chainsafe/lodestar-config";

export type ReturnType = {
  beaconNodeOptions: BeaconNodeOptions;
  config: IBeaconConfig;
};

/**
 * Initialize lodestar-cli with an on-disk configuration
 */
export async function initHandler(args: IBeaconArgs & IGlobalArgs): Promise<ReturnType> {
  const {beaconNodeOptions, config} = await initializeOptionsAndConfig(args);
  await persistOptionsAndConfig(args, beaconNodeOptions, config);
  return {beaconNodeOptions, config};
}

export async function initializeOptionsAndConfig(args: IBeaconArgs & IGlobalArgs): Promise<ReturnType> {
  const beaconPaths = getBeaconPaths(args);
  const beaconNodeOptions = new BeaconNodeOptions({
    network: args.network || "mainnet",
    configFile: beaconPaths.configFile,
    beaconNodeOptionsCli: parseBeaconNodeArgs(args),
  });

  // Auto-setup network
  // Only download files if params file does not exist
  if (args.network && !fs.existsSync(beaconPaths.paramsFile)) {
    try {
      const bootEnrs = await fetchBootnodes(args.network);
      beaconNodeOptions.set({network: {discv5: {bootEnrs}}});
    } catch (e: unknown) {
      // eslint-disable-next-line no-console
      console.error(`Error fetching latest bootnodes: ${e.stack}`);
    }
  }

  // initialize params file, if it doesn't exist
  const config = getBeaconConfigFromArgs(args);

  return {beaconNodeOptions, config};
}

/**
 * Write options and configs to disk
 */
export async function persistOptionsAndConfig(
  args: IBeaconArgs & IGlobalArgs,
  beaconNodeOptions: BeaconNodeOptions,
  beaconConfig: IBeaconConfig
): Promise<void> {
  const beaconPaths = getBeaconPaths(args);

  // initialize directories
  mkdir(beaconPaths.rootDir);
  mkdir(beaconPaths.beaconDir);
  mkdir(beaconPaths.dbDir);

  // initialize peer id & ENR, if either doesn't exist
  if (!fs.existsSync(beaconPaths.peerIdFile) || !fs.existsSync(beaconPaths.enrFile)) {
    await initPeerId(beaconPaths.peerIdFile);
    const peerId = await readPeerId(beaconPaths.peerIdFile);
    // initialize local enr
    initEnr(beaconPaths.enrFile, peerId);
  }

  if (!fs.existsSync(beaconPaths.paramsFile)) {
    writeBeaconParams(beaconPaths.paramsFile, beaconConfig.params);
  }

  // initialize beacon configuration file, if it doesn't exist
  if (!fs.existsSync(beaconPaths.configFile)) {
    beaconNodeOptions.writeTo(beaconPaths.configFile);
  }
}
