import {BeaconParams, IBeaconParams} from "@chainsafe/lodestar-params";

export class NotEqualParamsError extends Error {}

/**
 * Assert that two IBeaconParams are identical. Throws error otherwise
 */
export function assertEqualParams(currentParams: IBeaconParams, expectedParams: IBeaconParams): void {
  const params1Json = BeaconParams.toJson(currentParams) as Record<string, unknown>;
  const params2Json = BeaconParams.toJson(expectedParams) as Record<string, unknown>;
  const keys = new Set([...Object.keys(params1Json), ...Object.keys(params2Json)]);

  const errors: string[] = [];

  for (const key of keys) {
    if (!params1Json[key]) errors.push(`${key} not in current params`);
    if (!params2Json[key]) errors.push(`${key} not in expected params`);
    if (params1Json[key] !== params2Json[key])
      errors.push(`${key} different value: ${params1Json[key]} != ${params2Json[key]}`);
  }

  if (errors.length > 0) {
    throw new NotEqualParamsError("Not equal BeaconParams\n" + errors.join("\n"));
  }
}
