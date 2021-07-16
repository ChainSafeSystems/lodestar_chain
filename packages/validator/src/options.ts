import {getDefaultGraffiti} from "@chainsafe/lodestar-utils";

export interface IAccountPathOptions {
  keystoresDir?: string;
  secretsDir?: string;
}

export interface IValidatorOptions {
  graffiti: string;
  account: IAccountPathOptions;
}

export const defaultOptions: IValidatorOptions = {
  graffiti: getDefaultGraffiti(),
  account: {},
};
