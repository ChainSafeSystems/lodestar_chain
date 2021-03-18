import {ApiController} from "../../types";
import {DefaultQuery} from "fastify";
import {toRestValidationError} from "../../utils";

export const getBlockAttestations: ApiController<DefaultQuery, {blockId: string}> = {
  url: "/blocks/:blockId/attestations",

  handler: async function (req, resp) {
    try {
      const data = await this.api.beacon.blocks.getBlock(req.params.blockId);
      if (!data) {
        return resp.status(404).send();
      }
      return resp.status(200).send({
        data: Array.from(data.message.body.attestations).map((attestations) => {
          this.config.types.phase0.Attestation.toJson(attestations, {case: "snake"});
        }),
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
