import {execSync} from "child_process";
import {getLocalVersion} from "@chainsafe/lodestar-utils";

// This file is created in the build step and is distributed through NPM
// MUST be in sync with packages/cli/src/gitData/gitDataPath.ts, and package.json .files
import {GitDataFile, readGitDataFile} from "./gitDataPath";

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
type GitData = {
  /** "0.16.0" */
  semver: string;
  /** "developer/feature-1" */
  branch: string;
  /** "4f816b16dfde718e2d74f95f2c8292596138c248" */
  commit: string;
  /** "0.16.0 developer/feature-1 ac99f2b5" */
  version: string;
};

/** Silent shell that won't pollute stdout, or stderr */
function shell(cmd: string): string {
  return execSync(cmd, {stdio: ["ignore", "pipe", "ignore"]})
    .toString()
    .trim();
}

function getBranch(): string | undefined {
  try {
    return shell("git rev-parse --abbrev-ref HEAD");
  } catch (e) {
    return undefined;
  }
}

function getCommit(): string | undefined {
  try {
    return shell("git rev-parse --verify HEAD");
  } catch (e) {
    return undefined;
  }
}

export function getGitData(): Partial<Pick<GitData, "branch" | "commit">> {
  return {
    branch: getBranch(),
    commit: getCommit(),
  };
}

/**
 * Reads git data from a persisted file at build time + the current version in the package.json
 */
export function readLodestarGitData(): GitData {
  try {
    const semver = getLocalVersion() ?? undefined;
    const currentGitData = getGitData();
    const persistedGitData = getPersistedGitData();
    // If the CLI is run from source, prioritze current git data over .git-data.json file, which might be stale
    const gitData = {...persistedGitData, ...currentGitData};

    return {
      semver: semver || "-",
      branch: gitData?.branch || "-",
      commit: gitData?.commit || "-",
      version: formatVersion({...gitData, semver}),
    };
  } catch (e) {
    return {semver: "", branch: "", commit: "", version: e.message};
  }
}

function formatVersion({semver, branch, commit}: Partial<GitData>): string {
  return [semver, branch, commit && commit.slice(0, 8)].filter((s) => s).join(" ");
}

function getPersistedGitData(): Partial<GitDataFile> {
  try {
    return readGitDataFile();
  } catch (e) {
    return {};
  }
}
