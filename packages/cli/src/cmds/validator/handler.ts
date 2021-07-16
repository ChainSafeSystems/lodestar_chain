import {AbortController} from "@chainsafe/abort-controller";
import {getClient} from "@chainsafe/lodestar-api";
import {Validator, SlashingProtection} from "@chainsafe/lodestar-validator";
import {LevelDbController} from "@chainsafe/lodestar-db";
import {getBeaconConfigFromArgs} from "../../config";
import {IGlobalArgs} from "../../options";
import {YargsError, initBLS, mkdir, getCliLogger} from "../../util";
import {onGracefulShutdown, readLodestarGitData} from "../../util";
import {getBeaconPaths} from "../beacon/paths";
import {getValidatorPaths} from "./paths";
import {IValidatorCliArgs, parseValidatorArgs} from "./options";
import {getSecretKeys} from "./keys";
import {ValidatorOptions} from "../../config/validatorOptions";

/**
 * Run a validator client
 */
export async function validatorHandler(args: IValidatorCliArgs & IGlobalArgs): Promise<void> {
  await initBLS();
  const validatorPaths = getValidatorPaths(args);
  const validatorOptions = new ValidatorOptions({
    configFile: validatorPaths.configFile,
    validatorOptionsCli: parseValidatorArgs(args),
  });
  validatorOptions.writeTo(validatorPaths.configFile);

  const opts = validatorOptions.getWithDefaults();
  const graffiti = opts.graffiti;

  //Object.assign(args,{configFile:undefined}); //configFile if provided was for validator
  const beaconPaths = getBeaconPaths(args);
  const config = getBeaconConfigFromArgs(args);

  const logger = getCliLogger(args, beaconPaths, config);

  const lodestarGitData = readLodestarGitData();
  logger.info("Lodestar", {version: lodestarGitData.version, network: args.network});

  const secretKeys = await getSecretKeys(args, opts.account);
  if (secretKeys.length === 0) throw new YargsError("No validator keystores found");
  logger.info(`Decrypted ${secretKeys.length} validator keystores`);

  const dbPath = validatorPaths.validatorsDbDir;
  mkdir(dbPath);

  const onGracefulShutdownCbs: (() => Promise<void>)[] = [];
  onGracefulShutdown(async () => {
    for (const cb of onGracefulShutdownCbs) await cb();
  }, logger.info.bind(logger));

  // This AbortController interrupts the sleep() calls when waiting for genesis
  const controller = new AbortController();
  onGracefulShutdownCbs.push(async () => controller.abort());

  const api = getClient(config, {baseUrl: args.server});
  const slashingProtection = new SlashingProtection({
    config: config,
    controller: new LevelDbController({name: dbPath}, {logger}),
  });
  const validator = await Validator.initializeFromBeaconNode(
    {opts, config, slashingProtection, api, logger, secretKeys, graffiti},
    controller.signal
  );

  onGracefulShutdownCbs.push(async () => await validator.stop());
  await validator.start();
}
