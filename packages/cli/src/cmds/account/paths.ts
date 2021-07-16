import path from "path";
import {IGlobalArgs} from "../../options";
import {IGlobalPaths, getGlobalPaths} from "../../paths/global";
import {IAccountPathOptions} from "@chainsafe/lodestar-validator";

export interface IAccountPaths {
  keystoresDir: string;
  secretsDir: string;
  walletsDir: string;
}

/**
 * Defines the path structure of the account files
 *
 * ```bash
 * $accountsRootDir
 * ├── secrets
 * |   ├── 0x8e41b969493454318c27ec6fac90645769331c07ebc8db5037...
 * |   └── 0xa329f988c16993768299643d918a2694892c012765d896a16f...
 * ├── keystores
 * |   ├── 0x8e41b969493454318c27ec6fac90645769331c07ebc8db5037...
 * |   |   ├── eth1-deposit-data.rlp
 * |   |   ├── eth1-deposit-gwei.txt
 * |   |   └── voting-keystore.json
 * |   └── 0xa329f988c16993768299643d918a2694892c012765d896a16f...
 * |       ├── eth1-deposit-data.rlp
 * |       ├── eth1-deposit-gwei.txt
 * |       └── voting-keystore.json
 * ├── wallet1.pass (arbitrary path)
 * └── wallets
 *     └── 96ae14b4-46d7-42dc-afd8-c782e9af87ef (dir)
 *         └── 96ae14b4-46d7-42dc-afd8-c782e9af87ef (json)
 * ```
 */
// Using Pick<IGlobalArgs, "rootDir"> make changes in IGlobalArgs throw a type error here
export function getAccountPaths(
  args: Partial<IAccountPaths> & Pick<IGlobalArgs, "rootDir">,
  opts?: IAccountPathOptions
): IAccountPaths & IGlobalPaths {
  // Compute global paths first
  const globalPaths = getGlobalPaths(args);

  const rootDir = globalPaths.rootDir;
  const keystoresDir = opts?.keystoresDir || args.keystoresDir || path.join(rootDir, "keystores");
  const secretsDir = opts?.secretsDir || args.secretsDir || path.join(rootDir, "secrets");
  const walletsDir = args.walletsDir || path.join(rootDir, "wallets");
  return {
    ...globalPaths,
    keystoresDir,
    secretsDir,
    walletsDir,
  };
}

/**
 * Constructs representations of the path structure to show in command's description
 */
export const defaultAccountPaths = getAccountPaths({rootDir: "$rootDir"});
