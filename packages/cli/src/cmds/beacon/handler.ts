import {AbortController} from "abort-controller";

import {ErrorAborted} from "@chainsafe/lodestar-utils";
import {LevelDbController} from "@chainsafe/lodestar-db";
import {BeaconNode, BeaconDb, createNodeJsLibp2p} from "@chainsafe/lodestar";

import {IGlobalArgs} from "../../options";
import {parseEnrArgs} from "../../options/enrOptions";
import {initializeOptionsAndConfig, persistOptionsAndConfig} from "../init/handler";
import {IBeaconArgs} from "./options";
import {getBeaconPaths} from "./paths";
import {initBLS, onGracefulShutdown, getCliLogger} from "../../util";
import {readLodestarGitData} from "../../util/gitData";
import {FileENR, overwriteEnrWithCliArgs, readPeerId} from "../../config";
import {initBeaconState} from "./initBeaconState";

/**
 * Run a beacon node
 */
export async function beaconHandler(args: IBeaconArgs & IGlobalArgs): Promise<void> {
  await initBLS();

  const {beaconNodeOptions, config} = await initializeOptionsAndConfig(args);
  await persistOptionsAndConfig(args, beaconNodeOptions, config);

  const lodestarGitData = readLodestarGitData();
  const beaconPaths = getBeaconPaths(args);
  // TODO: Rename db.name to db.path or db.location
  beaconNodeOptions.set({db: {name: beaconPaths.dbDir}});
  // Add metrics metadata to show versioning + network info in Prometheus + Grafana
  beaconNodeOptions.set({metrics: {metadata: {...lodestarGitData, network: args.network}}});

  // ENR setup
  const peerId = await readPeerId(beaconPaths.peerIdFile);
  const enr = FileENR.initFromFile(beaconPaths.enrFile, peerId);
  const enrArgs = parseEnrArgs(args);
  overwriteEnrWithCliArgs(enr, enrArgs, beaconNodeOptions.getWithDefaults());
  const enrUpdate = !enrArgs.ip && !enrArgs.ip6;
  beaconNodeOptions.set({network: {discv5: {enr, enrUpdate}}});
  const options = beaconNodeOptions.getWithDefaults();

  const abortController = new AbortController();
  const logger = getCliLogger(args, beaconPaths, config);
  logger.info("Lodestar", {version: lodestarGitData.version, network: args.network, preset: args.preset});

  onGracefulShutdown(async () => {
    abortController.abort();
  }, logger.info.bind(logger));

  const db = new BeaconDb({
    config,
    controller: new LevelDbController(options.db, {logger: logger.child(options.logger.db)}),
  });

  await db.start();

  // BeaconNode setup
  try {
    const anchorState = await initBeaconState(options, args, config, db, logger, abortController.signal);
    const node = await BeaconNode.init({
      opts: options,
      config,
      db,
      logger,
      libp2p: await createNodeJsLibp2p(peerId, options.network, {peerStoreDir: beaconPaths.peerStoreDir}),
      anchorState,
    });

    abortController.signal.addEventListener("abort", () => node.close(), {once: true});
  } catch (e) {
    await db.stop();

    if (e instanceof ErrorAborted) {
      logger.info(e.message); // Let the user know the abort was received but don't print as error
    } else {
      throw e;
    }
  }
}
