import {DOMAIN_RANDAO} from "@chainsafe/lodestar-params";
import {allForks, ssz} from "@chainsafe/lodestar-types";
import {
  computeEpochAtSlot,
  computeSigningRoot,
  getDomain,
  ISignatureSet,
  SignatureSetType,
  verifySignatureSet,
} from "../../util";
import {CachedBeaconState} from "../util";

export function verifyRandaoSignature(
  state: CachedBeaconState<allForks.BeaconState>,
  block: allForks.BeaconBlock
): boolean {
  return verifySignatureSet(getRandaoRevealSignatureSet(state, block));
}

/**
 * Extract signatures to allow validating all block signatures at once
 */
export function getRandaoRevealSignatureSet(
  state: CachedBeaconState<allForks.BeaconState>,
  block: allForks.BeaconBlock
): ISignatureSet {
  const {epochCtx} = state;
  // should not get epoch from epochCtx
  const epoch = computeEpochAtSlot(block.slot);
  const domain = getDomain(state, DOMAIN_RANDAO, epoch);

  return {
    type: SignatureSetType.single,
    pubkey: epochCtx.index2pubkey[block.proposerIndex],
    signingRoot: computeSigningRoot(ssz.Epoch, epoch, domain),
    signature: block.body.randaoReveal.valueOf() as Uint8Array,
  };
}