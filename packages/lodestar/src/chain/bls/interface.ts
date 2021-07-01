import {ISignatureSet} from "@chainsafe/lodestar-beacon-state-transition/src";

export type VerifySignatureOpts = {
  batchable?: boolean;
};

export interface IBlsVerifier {
  /**
   * Verify 1 or more signature sets. Sets may be verified on batch or not depending on their count
   *
   * Signatures all come from the wire (untrusted) are all bytes compressed, must be:
   * - Parsed from bytes
   * - Uncompressed
   * - subgroup_check
   * - consume in Pairing.aggregate as affine, or mul_n_aggregate as affine
   * Just send the raw signture recevied as bytes to the thread and verify there
   *
   * Pubkeys all come from cache (trusted) have already been checked for subgroup and infinity
   * - Some pubkeys will have to be aggregated, some don't
   * - Pubkeys must be available in jacobian coordinates to make aggregation x3 faster
   * - Then, consume in Pairing.aggregate as affine, or mul_n_aggregate as affine
   *
   * All signatures are not trusted and must be group checked (p2.subgroup_check)
   *
   * Public keys have already been checked for subgroup and infinity
   * Signatures have already been checked for subgroup
   * Signature checks above could be done here for convienence as well
   */
  verifySignatureSets(sets: ISignatureSet[], opts?: VerifySignatureOpts): Promise<boolean>;
}
