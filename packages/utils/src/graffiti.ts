import {getLocalVersion} from "./version";

const lodestarPackageName = "chainsafe/lodestar";

/**
 * Computes a default graffiti fetching dynamically the package info
 */
export function getDefaultGraffiti(): string {
  try {
    const version = getLocalVersion();
    return version ? `${lodestarPackageName}-${version}` : lodestarPackageName;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Error guessing lodestar version", e);
    return lodestarPackageName;
  }
}
