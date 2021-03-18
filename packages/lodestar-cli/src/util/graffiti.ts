// eslint-disable-next-line import/default
import readPkgUp from "read-pkg-up";

const lodestarPackageName = "chainsafe/lodestar";

/**
 * Guesses the package version finding up the closest package.json
 */
function guessVersion(): string {
  const res = readPkgUp.sync();
  if (!res) throw Error("No package.json found");
  const version = res.packageJson.version;
  if (!version) throw Error(`No version in ${res.path}`);
  return version;
}

/**
 * Computes a default graffiti fetching dynamically the package info
 */
export function getDefaultGraffiti(): string {
  try {
    return `${lodestarPackageName}-${guessVersion()}`;
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.error("Error guessing lodestar version", e);
    return lodestarPackageName;
  }
}
