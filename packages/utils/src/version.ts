import fs from "fs";
import findUp from "find-up";

type LernaJson = {
  /** "0.18.0" */
  version: string;
};

/** Returns local version from `lerna.json` as `"0.18.0"` */
export function getLocalVersion(): string | null {
  return readVersionFromLernaJson() || readCliPackageJson();
}

function readVersionFromLernaJson(): string | null {
  const filePath = findUp.sync("lerna.json");
  if (!filePath) return null;

  const lernaJson = JSON.parse(fs.readFileSync(filePath, "utf8")) as LernaJson;
  return lernaJson.version;
}

function readCliPackageJson(): string | null {
  const filePath = findUp.sync("package.json", {cwd: __dirname});
  if (!filePath) return null;

  const packageJson = JSON.parse(fs.readFileSync(filePath, "utf8")) as LernaJson;
  return packageJson.version;
}
