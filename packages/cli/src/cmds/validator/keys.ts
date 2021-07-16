import {SecretKey} from "@chainsafe/bls";
import {deriveEth2ValidatorKeys, deriveKeyFromMnemonic} from "@chainsafe/bls-keygen";
import {interopSecretKey} from "@chainsafe/lodestar-beacon-state-transition";
import {defaultNetwork, IGlobalArgs} from "../../options";
import {parseRange, YargsError} from "../../util";
import {ValidatorDirManager} from "../../validatorDir";
import {getAccountPaths} from "../account/paths";
import {IValidatorCliArgs} from "./options";
import {IAccountPathOptions} from "@chainsafe/lodestar-validator";

export async function getSecretKeys(
  args: IValidatorCliArgs & IGlobalArgs,
  opts?: IAccountPathOptions
): Promise<SecretKey[]> {
  // UNSAFE - ONLY USE FOR TESTNETS. Derive keys directly from a mnemonic
  if (args.fromMnemonic) {
    if (args.network === defaultNetwork) {
      throw new YargsError("fromMnemonic must only be used in testnets");
    }
    if (!args.mnemonicIndexes) {
      throw new YargsError("Must specify mnemonicIndexes with fromMnemonic");
    }

    const masterSK = deriveKeyFromMnemonic(args.fromMnemonic);
    const indexes = parseRange(args.mnemonicIndexes);
    return indexes.map((index) => {
      const {signing} = deriveEth2ValidatorKeys(masterSK, index);
      return SecretKey.fromBytes(signing);
    });
  }

  // Derive interop keys
  else if (args.interopIndexes) {
    const indexes = parseRange(args.interopIndexes);
    return indexes.map((index) => interopSecretKey(index));
  }

  // Read keys from local account manager
  else {
    const accountPaths = getAccountPaths(args, opts);
    const validatorDirManager = new ValidatorDirManager(accountPaths);
    return await validatorDirManager.decryptAllValidators({force: args.force});
  }
}
