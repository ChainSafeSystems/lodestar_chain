import fs from "fs";
import {promisify} from "util";
import rimraf from "rimraf";
import path from "path";
import {AbortController} from "abort-controller";
import {GENESIS_SLOT} from "@chainsafe/lodestar-params";
import {BeaconNode, BeaconDb, initStateFromAnchorState, createNodeJsLibp2p, nodeUtils} from "@chainsafe/lodestar";
import {SlashingProtection, Validator} from "@chainsafe/lodestar-validator";
import {LevelDbController} from "@chainsafe/lodestar-db";
import {onGracefulShutdown} from "../../util/process";
import {createEnr, createPeerId} from "../../config";
import {IGlobalArgs} from "../../options";
import {IDevArgs} from "./options";
import {initializeOptionsAndConfig} from "../init/handler";
import {mkdir, initBLS, getCliLogger} from "../../util";
import {getBeaconPaths} from "../beacon/paths";
import {getValidatorPaths} from "../validator/paths";
import {interopSecretKey} from "@chainsafe/lodestar-beacon-state-transition";
import {SecretKey} from "@chainsafe/bls";

/**
 * Run a beacon node with validator
 */
export async function devHandler(args: IDevArgs & IGlobalArgs): Promise<void> {
  await initBLS();

  const {beaconNodeOptions, config} = await initializeOptionsAndConfig(args);

  // ENR setup
  const peerId = await createPeerId();
  const enr = createEnr(peerId);
  beaconNodeOptions.set({network: {discv5: {enr}}});

  // Custom paths different than regular beacon, validator paths
  // network="dev" will store all data in separate dir than other networks
  args.network = "dev";
  const beaconPaths = getBeaconPaths(args);
  const validatorPaths = getValidatorPaths(args);
  const beaconDbDir = beaconPaths.dbDir;
  const validatorsDbDir = validatorPaths.validatorsDbDir;

  mkdir(beaconDbDir);
  mkdir(validatorsDbDir);

  // TODO: Rename db.name to db.path or db.location
  beaconNodeOptions.set({db: {name: beaconPaths.dbDir}});
  const options = beaconNodeOptions.getWithDefaults();

  // BeaconNode setup
  const libp2p = await createNodeJsLibp2p(peerId, options.network);
  const logger = getCliLogger(args, beaconPaths, config);

  const db = new BeaconDb({config, controller: new LevelDbController(options.db, {logger})});
  await db.start();

  let anchorState;
  if (args.genesisValidators) {
    const interop = await nodeUtils.getInteropState(config, args.genesisValidators);
    await nodeUtils.storeDeposits(config, db, interop.deposits);
    await nodeUtils.storeSSZState(config, interop.state, path.join(args.rootDir, "dev", "genesis.ssz"));
    anchorState = interop.state;
  } else if (args.genesisStateFile) {
    anchorState = await initStateFromAnchorState(
      config,
      db,
      logger,
      config
        .getForkTypes(GENESIS_SLOT)
        .BeaconState.createTreeBackedFromBytes(
          await fs.promises.readFile(path.join(args.rootDir, args.genesisStateFile))
        )
    );
  } else {
    throw new Error("Unable to start node: no available genesis state");
  }

  const validators: Validator[] = [];

  const node = await BeaconNode.init({
    opts: options,
    config,
    db,
    logger,
    libp2p,
    anchorState,
  });

  const onGracefulShutdownCbs: (() => Promise<void>)[] = [];
  onGracefulShutdown(async () => {
    for (const cb of onGracefulShutdownCbs) await cb();
    await Promise.all([Promise.all(validators.map((v) => v.stop())), node.close()]);
    if (args.reset) {
      logger.info("Cleaning db directories");
      await promisify(rimraf)(beaconDbDir);
      await promisify(rimraf)(validatorsDbDir);
    }
  }, logger.info.bind(logger));

  if (args.startValidators) {
    const secretKeys: SecretKey[] = [];
    const [fromIndex, toIndex] = args.startValidators.split(":").map((s) => parseInt(s));
    for (let i = fromIndex; i < toIndex; i++) {
      secretKeys.push(interopSecretKey(i));
    }

    const dbPath = path.join(validatorsDbDir, "validators");
    fs.mkdirSync(dbPath, {recursive: true});

    const api = args.server === "memory" ? node.api : args.server;
    const slashingProtection = new SlashingProtection({
      config: config,
      controller: new LevelDbController({name: dbPath}, {logger}),
    });

    const controller = new AbortController();
    onGracefulShutdownCbs.push(async () => controller.abort());

    // Initailize genesis once for all validators
    const validator = await Validator.initializeFromBeaconNode({config, slashingProtection, api, logger, secretKeys});

    onGracefulShutdownCbs.push(() => validator.stop());
    await validator.start();
  }
}
