import {ApiController} from "../../types";
import {DefaultQuery} from "fastify";
import {StateId} from "../../../../impl/beacon/state";
import {toRestValidationError} from "../../utils";

type Params = {
  stateId: StateId;
};

export const getStateFork: ApiController<DefaultQuery, Params> = {
  url: "/states/:stateId/fork",

  handler: async function (req, resp) {
    try {
      const fork = await this.api.beacon.state.getFork(req.params.stateId);
      if (!fork) {
        return resp.status(404).send();
      }
      return resp.status(200).send({
        data: this.config.types.phase0.Fork.toJson(fork, {case: "snake"}),
      });
    } catch (e: unknown) {
      if (e.message === "Invalid state id") {
        throw toRestValidationError("state_id", e.message);
      }
      throw e;
    }
  },

  opts: {
    schema: {
      params: {
        type: "object",
        required: ["stateId"],
        properties: {
          stateId: {
            types: "string",
          },
        },
      },
    },
  },
};
