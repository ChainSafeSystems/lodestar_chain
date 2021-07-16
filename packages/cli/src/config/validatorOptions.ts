import deepmerge from "deepmerge";
import {Json} from "@chainsafe/ssz";
import {defaultOptions, IValidatorOptions} from "@chainsafe/lodestar-validator";
import {isPlainObject, RecursivePartial} from "@chainsafe/lodestar-utils";
import {writeFile, readFileIfExists} from "../util";

export class ValidatorOptions {
  private validatorOptions: RecursivePartial<IValidatorOptions>;

  /**
   * Reads, parses and merges BeaconNodeOptions from (in order)
   * - Network options (diff)
   * - existing options file
   * - CLI flags
   */
  constructor({
    configFile,
    validatorOptionsCli,
  }: {
    configFile?: string;
    validatorOptionsCli: RecursivePartial<IValidatorOptions>;
  }) {
    this.validatorOptions = mergeValidatorOptions(
      configFile ? readValidatorOptionsIfExists(configFile) : {},
      validatorOptionsCli
    );
  }

  /**
   * Returns current options
   */
  get(): RecursivePartial<IValidatorOptions> {
    return this.validatorOptions;
  }

  /**
   * Returns merged current options with defaultOptions
   */
  getWithDefaults(): IValidatorOptions {
    return mergeValidatorOptionsWithDefaults(defaultOptions, this.validatorOptions);
  }

  writeTo(filepath: string): void {
    writeFile(filepath, this.validatorOptions as Json);
  }
}

/**
 * This needs to be a synchronous function because it will be run as part of the yargs 'build' step
 * If the config file is not found, the default values will apply.
 */
export function readValidatorOptionsIfExists(filepath: string): RecursivePartial<IValidatorOptions> {
  return readFileIfExists(filepath) || {};
}

/**
 * Typesafe wrapper to merge partial IBeaconNodeOptions objects
 */
export function mergeValidatorOptions(
  ...partialOptionsArr: RecursivePartial<IValidatorOptions>[]
): RecursivePartial<IValidatorOptions> {
  return partialOptionsArr.reduce((mergedValidatorOptions, options) => {
    // IValidatorOptions contains instances so a deepmerge can only be done safely with `isMergeableObject: isPlainObject`
    return deepmerge(mergedValidatorOptions, options, {
      arrayMerge: overwriteTargetArrayIfItems,
      isMergeableObject: isPlainObject,
    });
  }, partialOptionsArr[0]);
}

/**
 * Typesafe wrapper to merge IBeaconNodeOptions objects
 */
export function mergeValidatorOptionsWithDefaults(
  defaultOptions: IValidatorOptions,
  ...partialOptionsArr: RecursivePartial<IValidatorOptions>[]
): IValidatorOptions {
  return mergeValidatorOptions(defaultOptions, ...partialOptionsArr) as IValidatorOptions;
}

/**
 * If override array option (source) is defined and has items
 * replace target (original option).
 * Example: network.localMultiaddrs has default ['/ip4/127.0.0.1/tcp/30606'] and we don't wanna append to that with cli flag
 * as it could result in port taken
 * @param target
 * @param source
 */
function overwriteTargetArrayIfItems(target: unknown[], source: unknown[]): unknown[] {
  if (source.length === 0) {
    return target;
  }
  return source;
}
