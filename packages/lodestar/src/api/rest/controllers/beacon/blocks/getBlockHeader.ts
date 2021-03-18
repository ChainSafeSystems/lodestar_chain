import {ApiController} from "../../types";
import {DefaultQuery} from "fastify";
import {toRestValidationError} from "../../utils";

export const getBlockHeader: ApiController<DefaultQuery, {blockId: string}> = {
  url: "/headers/:blockId",

  handler: async function (req, resp) {
    try {
      const data = await this.api.beacon.blocks.getBlockHeader(req.params.blockId);
      if (!data) {
        return resp.status(404).send();
      }
      return resp.status(200).send({
        data: this.config.types.phase0.SignedBeaconHeaderResponse.toJson(data, {case: "snake"}),
      });
    } catch (e: unknown) {
      if (e.message === "Invalid block id") {
        throw toRestValidationError("block_id", e.message);
      }
      throw e;
    }
  },

  opts: {
    schema: {
      params: {
        type: "object",
        required: ["blockId"],
        properties: {
          blockId: {
            types: "string",
          },
        },
      },
    },
  },
};
