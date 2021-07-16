import {ICliCommand, initBLS, YargsError} from "../../../../util";
import {IGlobalArgs} from "../../../../options";
import {Validator} from "@chainsafe/lodestar-validator";
import {ValidatorDirManager} from "../../../../validatorDir";
import {getAccountPaths} from "../../paths";
import {getBeaconConfigFromArgs} from "../../../../config";
import {errorLogger} from "../../../../util/logger";
import {IValidatorCliArgs, validatorOptions, parseValidatorArgs} from "../../../validator/options";
import inquirer from "inquirer";
import {readdirSync} from "fs";
import {getSlashingProtection} from "./slashingProtection/utils";
import {ValidatorOptions} from "../../../../config/validatorOptions";

/* eslint-disable no-console */

export type IValidatorVoluntaryExitArgs = IValidatorCliArgs & {
  publicKey: string;
  exitEpoch: number;
};

export type ReturnType = string[];

export const voluntaryExit: ICliCommand<IValidatorVoluntaryExitArgs, IGlobalArgs> = {
  command: "voluntary-exit",

  describe:
    "Performs a voluntary exit for a given validator (as identified via `publicKey`.  \
If no `publicKey` is provided, a prompt will ask the user which validator they would \
like to choose for the voluntary exit.",

  examples: [
    {
      command: "account validator voluntary-exit --publicKey 0xF00",
      description: "Perform a voluntary exit for the validator who has a public key 0xF00",
    },
  ],

  options: {
    ...validatorOptions,
    publicKey: {
      description: "The public key of the validator to voluntarily exit",
      type: "string",
    },
    exitEpoch: {
      description:
        "The epoch upon which to submit the voluntary exit.  If no value is provided, then we default to the currentEpoch.",
      type: "number",
    },
  },

  handler: async (args) => {
    await initBLS();

    const valOptions = new ValidatorOptions({validatorOptionsCli: parseValidatorArgs(args)});
    const opts = valOptions.getWithDefaults();

    const force = args.force;
    let publicKey = args.publicKey;
    const accountPaths = getAccountPaths(args);
    const validatorDirManager = new ValidatorDirManager(accountPaths);

    if (!publicKey) {
      const publicKeys = readdirSync(accountPaths.keystoresDir);

      const validator = await inquirer.prompt<{publicKey: string}>([
        {
          name: "publicKey",
          type: "list",
          message: "Which validator do you want to voluntarily exit from the network?",
          choices: [...publicKeys],
        },
      ]);
      publicKey = validator.publicKey;
    }

    const confirmation = await inquirer.prompt<{choice: string}>([
      {
        name: "choice",
        type: "list",
        message: `Are you sure you want to permantently exit validator ${publicKey} from the ${args.network} network?

WARNING: THIS CANNOT BE UNDONE.

ONCE YOU VOLUNTARILY EXIT, YOU WILL NOT BE ABLE TO WITHDRAW 
YOUR DEPOSIT UNTIL PHASE 2 IS LAUNCHED WHICH MAY NOT 
BE UNTIL AT LEAST TWO YEARS AFTER THE PHASE 0 MAINNET LAUNCH.

`,
        choices: ["NO", "YES"],
      },
    ]);

    if (confirmation.choice === "NO") return;

    console.log(`Initiating voluntary exit for validator ${publicKey}`);

    let secretKey;

    try {
      secretKey = await validatorDirManager.decryptValidator(publicKey, {force});
    } catch (error) {
      throw new YargsError(error);
    }
    if (!secretKey) throw new YargsError("No validator keystores found");
    console.log(`Decrypted keystore for validator ${publicKey}`);

    const config = getBeaconConfigFromArgs(args);

    const validatorClient = await Validator.initializeFromBeaconNode({
      opts,
      slashingProtection: getSlashingProtection(args),
      config,
      api: args.server,
      secretKeys: [secretKey],
      logger: errorLogger(),
      graffiti: args.graffiti,
    });

    try {
      await validatorClient.voluntaryExit(publicKey, args.exitEpoch);
    } catch (error) {
      throw new Error(error);
    }
  },
};
