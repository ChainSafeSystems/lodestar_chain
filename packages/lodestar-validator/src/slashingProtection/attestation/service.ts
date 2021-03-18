import {BLSPubkey, phase0} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {isEqualNonZeroRoot, minEpoch} from "../utils";
import {MinMaxSurround, SurroundAttestationError, SurroundAttestationErrorCode} from "../minMaxSurround";
import {InvalidAttestationError, InvalidAttestationErrorCode} from "./errors";
import {AttestationByTargetRepository} from "./attestationByTargetRepository";
import {AttestationLowerBoundRepository} from "./attestationLowerBoundRepository";

enum SafeStatus {
  SAME_DATA = "SAFE_STATUS_SAME_DATA",
  OK = "SAFE_STATUS_OK",
}

export class SlashingProtectionAttestationService {
  private config: IBeaconConfig;
  private attestationByTarget: AttestationByTargetRepository;
  private attestationLowerBound: AttestationLowerBoundRepository;
  private minMaxSurround: MinMaxSurround;

  constructor(
    config: IBeaconConfig,
    signedAttestationDb: AttestationByTargetRepository,
    attestationLowerBound: AttestationLowerBoundRepository,
    minMaxSurround: MinMaxSurround
  ) {
    this.config = config;
    this.attestationByTarget = signedAttestationDb;
    this.attestationLowerBound = attestationLowerBound;
    this.minMaxSurround = minMaxSurround;
  }

  /**
   * Check an attestation for slash safety, and if it is safe, record it in the database
   * This is the safe, externally-callable interface for checking attestations
   */
  async checkAndInsertAttestation(pubKey: BLSPubkey, att: phase0.SlashingProtectionAttestation): Promise<void> {
    const safeStatus = await this.checkAttestation(pubKey, att);

    if (safeStatus != SafeStatus.SAME_DATA) {
      await this.insertAttestation(pubKey, att);
    }

    // TODO: Implement safe clean-up of stored attestations
  }

  /**
   * Check an attestation from `pubKey` for slash safety.
   */
  async checkAttestation(pubKey: BLSPubkey, att: phase0.SlashingProtectionAttestation): Promise<SafeStatus> {
    // Although it's not required to avoid slashing, we disallow attestations
    // which are obviously invalid by virtue of their source epoch exceeding their target.
    if (att.sourceEpoch > att.targetEpoch) {
      throw new InvalidAttestationError({code: InvalidAttestationErrorCode.SOURCE_EXCEEDS_TARGET});
    }

    // Check for a double vote. Namely, an existing attestation with the same target epoch,
    // and a different signing root.
    const sameTargetAtt = await this.attestationByTarget.get(pubKey, att.targetEpoch);
    if (sameTargetAtt) {
      // Interchange format allows for attestations without signing_root, then assume root is equal
      if (isEqualNonZeroRoot(this.config, sameTargetAtt.signingRoot, att.signingRoot)) {
        return SafeStatus.SAME_DATA;
      } else {
        throw new InvalidAttestationError({code: InvalidAttestationErrorCode.DOUBLE_VOTE, att, prev: sameTargetAtt});
      }
    }

    // Check for a surround vote
    try {
      await this.minMaxSurround.assertNoSurround(pubKey, {source: att.sourceEpoch, target: att.targetEpoch});
    } catch (e: unknown) {
      if (e instanceof SurroundAttestationError) {
        const prev = await this.attestationByTarget.get(pubKey, e.type.att2Target).catch(() => null);
        switch (e.type.code) {
          case SurroundAttestationErrorCode.IS_SURROUNDING:
            throw new InvalidAttestationError({code: InvalidAttestationErrorCode.NEW_SURROUNDS_PREV, att, prev});
          case SurroundAttestationErrorCode.IS_SURROUNDED:
            throw new InvalidAttestationError({code: InvalidAttestationErrorCode.PREV_SURROUNDS_NEW, att, prev});
        }
      }
      throw e;
    }

    // Refuse to sign any attestation with:
    // - source.epoch < min(att.source_epoch for att in data.signed_attestations if att.pubkey == attester_pubkey), OR
    // - target_epoch <= min(att.target_epoch for att in data.signed_attestations if att.pubkey == attester_pubkey)
    // (spec v4, Slashing Protection Database Interchange Format)
    const attestationLowerBound = await this.attestationLowerBound.get(pubKey);
    if (attestationLowerBound) {
      const {minSourceEpoch, minTargetEpoch} = attestationLowerBound;
      if (att.sourceEpoch < minSourceEpoch) {
        throw new InvalidAttestationError({
          code: InvalidAttestationErrorCode.SOURCE_LESS_THAN_LOWER_BOUND,
          sourceEpoch: att.sourceEpoch,
          minSourceEpoch,
        });
      }

      if (att.targetEpoch <= minTargetEpoch) {
        throw new InvalidAttestationError({
          code: InvalidAttestationErrorCode.TARGET_LESS_THAN_OR_EQ_LOWER_BOUND,
          targetEpoch: att.targetEpoch,
          minTargetEpoch,
        });
      }
    }

    return SafeStatus.OK;
  }

  /**
   * Insert an attestation into the slashing database
   * This should *only* be called in the same (exclusive) transaction as `checkAttestation`
   * so that the check isn't invalidated by a concurrent mutation
   */
  async insertAttestation(pubKey: BLSPubkey, att: phase0.SlashingProtectionAttestation): Promise<void> {
    await this.attestationByTarget.set(pubKey, [att]);
    await this.minMaxSurround.insertAttestation(pubKey, {source: att.sourceEpoch, target: att.targetEpoch});
  }

  /**
   * Interchange import / export functionality
   */
  async importAttestations(pubkey: BLSPubkey, atts: phase0.SlashingProtectionAttestation[]): Promise<void> {
    await this.attestationByTarget.set(pubkey, atts);

    // Pre-compute spans for all attestations
    for (const att of atts) {
      await this.minMaxSurround.insertAttestation(pubkey, {source: att.sourceEpoch, target: att.targetEpoch});
    }

    // Pre-compute and store lower-bound
    const minSourceEpoch = minEpoch(atts.map((att) => att.sourceEpoch));
    const minTargetEpoch = minEpoch(atts.map((att) => att.targetEpoch));
    if (minSourceEpoch != null && minTargetEpoch != null) {
      await this.attestationLowerBound.set(pubkey, {minSourceEpoch, minTargetEpoch});
    }
  }

  /**
   * Interchange import / export functionality
   */
  async exportAttestations(pubkey: BLSPubkey): Promise<phase0.SlashingProtectionAttestation[]> {
    return await this.attestationByTarget.getAll(pubkey);
  }

  async listPubkeys(): Promise<BLSPubkey[]> {
    return await this.attestationByTarget.listPubkeys();
  }
}
