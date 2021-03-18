import {ApiController} from "../../types";
import {ValidationError} from "../../../../impl/errors/validation";
import {phase0} from "@chainsafe/lodestar-types";

export const submitPoolAttestation: ApiController = {
  url: "/pool/attestations",

  handler: async function (req, resp) {
    let attestation: phase0.Attestation;
    try {
      attestation = this.config.types.phase0.Attestation.fromJson(req.body, {case: "snake"});
    } catch (e: unknown) {
      throw new ValidationError("Failed to deserialize attestation");
    }
    await this.api.beacon.pool.submitAttestation(attestation);
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
