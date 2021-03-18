import {ApiController} from "../../types";
import {phase0} from "@chainsafe/lodestar-types";
import {ValidationError} from "../../../../impl/errors/validation";

export const publishBlock: ApiController = {
  url: "/blocks",

  handler: async function (req, resp) {
    let block: phase0.SignedBeaconBlock;
    try {
      block = this.config.types.phase0.SignedBeaconBlock.fromJson(req.body, {case: "snake"});
    } catch (e: unknown) {
      throw new ValidationError("Failed to deserialize block");
    }
    await this.api.beacon.blocks.publishBlock(block);
    resp.code(200).type("application/json").send();
  },

  opts: {
    schema: {
      body: {
        type: "object",
      },
    },
  },
};
