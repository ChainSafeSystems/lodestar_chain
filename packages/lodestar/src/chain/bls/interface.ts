import {ISignatureSet} from "@chainsafe/lodestar-beacon-state-transition/src";

export type VerifySignatureOpts = {
  /**
   * A batchable set MAY be verified with more sets to reduce the verification costs.
   * Multiple sets may be merged and verified as one set. If the result is correct, success is returned
   * for all them. If at least one set is invalid, all sets are reverified individually. For normal network
   * conditions this strategy can yield 50% improvement in CPU time spent verifying gossip objects.
   * Only non-time critical objects should be marked as batchable, since the pool may hold them for 100ms.
   */
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
