import {ICliCommandOptions, ILogArgs} from "../../util";
import {defaultValidatorPaths, IValidatorPaths} from "./paths";
import {accountValidatorOptions, IAccountValidatorArgs} from "../account/cmds/validator/options";
import {logOptions, beaconPathsOptions} from "../beacon/options";
import {IBeaconPaths} from "../beacon/paths";
import {IValidatorOptions} from "@chainsafe/lodestar-validator";
import {RecursivePartial} from "@chainsafe/lodestar-utils";
import {removeUndefinedRecursive} from "../../util";

export type IValidatorCliArgs = IAccountValidatorArgs &
  ILogArgs &
  IValidatorPaths & {
    server: string;
    force: boolean;
    graffiti: string;
    interopIndexes?: string;
    fromMnemonic?: string;
    mnemonicIndexes?: string;
    logFile: IBeaconPaths["logFile"];
  };

export function parseValidatorArgs(args: IValidatorCliArgs): RecursivePartial<IValidatorOptions> {
  // Remove undefined values to allow deepmerge to inject default values downstream
  return removeUndefinedRecursive({
    graffiti: args.graffiti,
    account: {keystoresDir: args.keystoresDir, secretsDir: args.secretsDir},
  });
}

export const validatorOptions: ICliCommandOptions<IValidatorCliArgs> = {
  ...accountValidatorOptions,
  ...logOptions,
  logFile: beaconPathsOptions.logFile,

  validatorsDbDir: {
    description: "Data directory for validator databases.",
    defaultDescription: defaultValidatorPaths.validatorsDbDir,
    type: "string",
  },

  configFile: {
    description: "Validator configuration file path",
    defaultDescription: defaultValidatorPaths.configFile,
    type: "string",
  },

  server: {
    description: "Address to connect to BeaconNode",
    default: "http://127.0.0.1:9596",
    type: "string",
  },

  force: {
    description: "Open validators even if there's a lockfile. Use with caution",
    type: "boolean",
  },

  graffiti: {
    description: "Specify your custom graffiti to be included in blocks (plain UTF8 text, 32 characters max)",
    // Don't use a default here since it should be computed only if necessary by getDefaultGraffiti()
    type: "string",
  },

  interopIndexes: {
    hidden: true,
    description: "Range (inclusive) of interop key indexes to validate with: 0..16",
    type: "string",
  },

  fromMnemonic: {
    hidden: true,
    description: "UNSAFE. Run keys from a mnemonic. Requires mnemonicIndexes option",
    type: "string",
  },

  mnemonicIndexes: {
    hidden: true,
    description: "UNSAFE. Range (inclusive) of mnemonic key indexes to validate with: 0..16",
    type: "string",
  },
};
