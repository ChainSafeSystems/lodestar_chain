import {phase0} from "@chainsafe/lodestar-types";
import {ValidationError} from "../../../../impl/errors/validation";
import {ApiController} from "../../types";

export const submitVoluntaryExit: ApiController = {
  url: "/pool/voluntary_exits",

  handler: async function (req, resp) {
    let exit: phase0.SignedVoluntaryExit;
    try {
      exit = this.config.types.phase0.SignedVoluntaryExit.fromJson(req.body, {case: "snake"});
    } catch (e: unknown) {
      throw new ValidationError("Failed to deserialize voluntary exit");
    }
    await this.api.beacon.pool.submitVoluntaryExit(exit);
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
