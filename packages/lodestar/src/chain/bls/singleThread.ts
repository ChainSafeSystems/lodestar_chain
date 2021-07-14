import {ISignatureSet} from "@chainsafe/lodestar-beacon-state-transition/src";
import {IBlsVerifier} from "./interface";
import {verifySignatureSetsMaybeBatch} from "./maybeBatch";
import {getAggregatedPubkey} from "./utils";

export class BlsSingleThreadVerifier implements IBlsVerifier {
  async verifySignatureSets(sets: ISignatureSet[]): Promise<boolean> {
    return verifySignatureSetsMaybeBatch(
      sets.map((set) => ({
        publicKey: getAggregatedPubkey(set),
        message: set.signingRoot.valueOf() as Uint8Array,
        signature: set.signature,
      }))
    );
  }
}
