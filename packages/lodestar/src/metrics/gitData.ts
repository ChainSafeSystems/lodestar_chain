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

/**
 * Reads git data injected on the Dockerfile to the filepath `DOCKER_LODESTAR_GIT_DATA_FILEPATH`
 * Expects a file with JSON contents:
 * ```js
 * {
 *   version: "0.16.0",
 *   branch: "developer/feature-1",
 *   commit: "4f816b16dfde718e2d74f95f2c8292596138c248"
 * }
 * ```
 */
export function readLodestarGitData(): GitData {
  try {
    const gitDataFilepath = process?.env?.DOCKER_LODESTAR_GIT_DATA_FILEPATH;
    if (!gitDataFilepath) throw Error("No DOCKER_LODESTAR_GIT_DATA_FILEPATH ENV");

    // Lazy load fs module only if necessary
    // eslint-disable-next-line
    const fs = require("fs");
    const gitData = JSON.parse(fs.readFileSync(gitDataFilepath, "utf8"));
    const {version: semver, branch, commit} = gitData;
    return {semver, branch, commit, version: `${semver} ${branch} ${commit.slice(0, 8)}`};
  } catch (e: unknown) {
    return {semver: "", branch: "", commit: "", version: e.message};
  }
}
