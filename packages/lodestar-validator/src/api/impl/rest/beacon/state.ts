import {BLSPubkey, ValidatorIndex, phase0} from "@chainsafe/lodestar-types";
import {Json} from "@chainsafe/ssz";
import {IBeaconStateApi} from "../../../interface/beacon";
import {RestApi} from "./abstract";

export class RestBeaconStateApi extends RestApi implements IBeaconStateApi {
  /**
   * Fetch given validator from a given state
   */
  async getStateValidator(
    stateId: "head",
    validatorId: ValidatorIndex | BLSPubkey
  ): Promise<phase0.ValidatorResponse | null> {
    let id = "";
    if (typeof validatorId === "number") {
      id = validatorId.toString();
    } else {
      id = this.config.types.BLSPubkey.toJson(validatorId)?.toString() ?? "";
    }
    try {
      return this.config.types.phase0.ValidatorResponse.fromJson(
        (await this.client.get<{data: Json}>(`/states/${stateId}/validators/${id}`)).data,
        {
          case: "snake",
        }
      );
    } catch (e: unknown) {
      this.logger.error("Failed to fetch validator", {validatorId: id, error: e.message});
      return null;
    }
  }

  async getFork(stateId: "head"): Promise<phase0.Fork | null> {
    try {
      return this.config.types.phase0.Fork.fromJson(
        (await this.client.get<{data: Json}>(`/states/${stateId}/fork`)).data,
        {
          case: "snake",
        }
      );
    } catch (e: unknown) {
      this.logger.error("Failed to fetch head fork version", {error: e.message});
      return null;
    }
  }
}
