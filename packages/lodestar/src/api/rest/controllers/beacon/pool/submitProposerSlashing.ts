import {phase0} from "@chainsafe/lodestar-types";
import {ValidationError} from "../../../../impl/errors/validation";
import {ApiController} from "../../types";

export const submitProposerSlashing: ApiController = {
  url: "/pool/proposer_slashings",
  method: "POST",

  handler: async function (req) {
    let slashing: phase0.ProposerSlashing;
    try {
      slashing = this.config.types.phase0.ProposerSlashing.fromJson(req.body, {case: "snake"});
    } catch (e) {
      throw new ValidationError("Failed to deserialize proposer slashing");
    }
    await this.api.beacon.pool.submitProposerSlashing(slashing);
    return {};
  },

  schema: {
    body: {
      type: "object",
    },
  },
};
