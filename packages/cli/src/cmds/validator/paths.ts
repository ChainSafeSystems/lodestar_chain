import path from "path";
import {IGlobalArgs} from "../../options";
import {IGlobalPaths, getGlobalPaths} from "../../paths/global";

export type IValidatorPaths = {
  validatorsDbDir: string;
  configFile: string;
};

/**
 * Defines the path structure of the validator files
 *
 * ```bash
 * $validatorRootDir
 * └── validator-db
 *     └── (db files)
 * ```
 */
export function getValidatorPaths(
  args: Partial<IValidatorPaths> & Pick<IGlobalArgs, "rootDir">
): IValidatorPaths & IGlobalPaths {
  // Compute global paths first
  const globalPaths = getGlobalPaths(args);

  const rootDir = globalPaths.rootDir;
  const validatorsDbDir = args.validatorsDbDir || path.join(rootDir, "validator-db");
  const configFile = args.configFile || path.join(rootDir, "validator.config.json");

  return {
    ...globalPaths,
    validatorsDbDir,
    configFile,
  };
}

/**
 * Constructs representations of the path structure to show in command's description
 */
export const defaultValidatorPaths = getValidatorPaths({rootDir: "$rootDir"});
