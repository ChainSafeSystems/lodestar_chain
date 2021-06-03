import {DOMAIN_BEACON_PROPOSER} from "@chainsafe/lodestar-params";
import {readonlyValues} from "@chainsafe/ssz";
import {allForks, phase0, ssz} from "@chainsafe/lodestar-types";
import {computeEpochAtSlot, computeSigningRoot, getDomain, ISignatureSet, SignatureSetType} from "../../util";
import {CachedBeaconState} from "../util";

/**
 * Extract signatures to allow validating all block signatures at once
 */
export function getProposerSlashingSignatureSets(
  state: CachedBeaconState<allForks.BeaconState>,
  proposerSlashing: phase0.ProposerSlashing
): ISignatureSet[] {
  const {epochCtx} = state;
  const pubkey = epochCtx.index2pubkey[proposerSlashing.signedHeader1.message.proposerIndex];

  return [proposerSlashing.signedHeader1, proposerSlashing.signedHeader2].map(
    (signedHeader): ISignatureSet => {
      const epochSig = computeEpochAtSlot(signedHeader.message.slot);
      const domain = getDomain(state, DOMAIN_BEACON_PROPOSER, epochSig);
      const beaconBlockHeaderType = ssz.phase0.BeaconBlockHeader;

      return {
        type: SignatureSetType.single,
        pubkey,
        signingRoot: computeSigningRoot(beaconBlockHeaderType, signedHeader.message, domain),
        signature: signedHeader.signature.valueOf() as Uint8Array,
      };
    }
  );
}

export function getProposerSlashingsSignatureSets(
  state: CachedBeaconState<allForks.BeaconState>,
  signedBlock: allForks.SignedBeaconBlock
): ISignatureSet[] {
  return Array.from(readonlyValues(signedBlock.message.body.proposerSlashings), (proposerSlashing) =>
    getProposerSlashingSignatureSets(state, proposerSlashing)
  ).flat(1);
}
