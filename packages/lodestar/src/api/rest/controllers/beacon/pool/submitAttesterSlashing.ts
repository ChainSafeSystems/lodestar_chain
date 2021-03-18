import {phase0} from "@chainsafe/lodestar-types";
import {ValidationError} from "../../../../impl/errors/validation";
import {ApiController} from "../../types";

export const submitAttesterSlashing: ApiController = {
  url: "/pool/attester_slashings",

  handler: async function (req, resp) {
    let slashing: phase0.AttesterSlashing;
    try {
      slashing = this.config.types.phase0.AttesterSlashing.fromJson(req.body, {case: "snake"});
    } catch (e: unknown) {
      throw new ValidationError("Failed to deserialize attester slashing");
    }
    await this.api.beacon.pool.submitAttesterSlashing(slashing);
    resp.status(200).send();
  },

  opts: {
    schema: {
      body: {
        type: "object",
      },
    },
  },
};
