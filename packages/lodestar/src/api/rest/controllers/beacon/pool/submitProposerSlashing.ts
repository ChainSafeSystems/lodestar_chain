import {phase0} from "@chainsafe/lodestar-types";
import {ValidationError} from "../../../../impl/errors/validation";
import {ApiController} from "../../types";

export const submitProposerSlashing: ApiController = {
  url: "/pool/proposer_slashings",

  handler: async function (req, resp) {
    let slashing: phase0.ProposerSlashing;
    try {
      slashing = this.config.types.phase0.ProposerSlashing.fromJson(req.body, {case: "snake"});
    } catch (e: unknown) {
      throw new ValidationError("Failed to deserialize proposer slashing");
    }
    await this.api.beacon.pool.submitProposerSlashing(slashing);
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
