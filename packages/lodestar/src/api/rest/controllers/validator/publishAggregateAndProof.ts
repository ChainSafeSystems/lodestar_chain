import {phase0} from "@chainsafe/lodestar-types";
import {Json} from "@chainsafe/ssz";
import {DefaultParams, DefaultQuery} from "fastify";
import {ApiController} from "../types";

type Body = Json[];

export const publishAggregateAndProof: ApiController<DefaultQuery, DefaultParams, Body> = {
  url: "/aggregate_and_proofs",

  handler: async function (req, resp) {
    const signedAggregateAndProofs: phase0.SignedAggregateAndProof[] = [];
    for (const aggreagteJson of req.body) {
      try {
        signedAggregateAndProofs.push(
          this.config.types.phase0.SignedAggregateAndProof.fromJson(aggreagteJson, {case: "snake"})
        );
      } catch (e: unknown) {
        this.log.warn("Failed to parse AggregateAndProof", e.message);
      }
    }
    await this.api.validator.publishAggregateAndProofs(signedAggregateAndProofs);
    resp.status(200).send();
  },

  opts: {
    schema: {
      body: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
        },
      },
    },
  },
};
