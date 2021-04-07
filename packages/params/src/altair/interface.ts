/* eslint-disable @typescript-eslint/naming-convention */

export interface IAltairParams {
  SYNC_COMMITTEE_SIZE: number;
  SYNC_PUBKEYS_PER_AGGREGATE: number;
  INACTIVITY_SCORE_BIAS: bigint;
  EPOCHS_PER_SYNC_COMMITTEE_PERIOD: number;
  DOMAIN_SYNC_COMMITTEE: Buffer;
  DOMAIN_SYNC_COMMITTEE_SELECTION_PROOF: Buffer;
  DOMAIN_CONTRIBUTION_AND_PROOF: Buffer;
  ALTAIR_FORK_VERSION: Buffer;
  ALTAIR_FORK_SLOT: number;
  INACTIVITY_PENALTY_QUOTIENT_ALTAIR: bigint;
  MIN_SLASHING_PENALTY_QUOTIENT_ALTAIR: number;
  PROPORTIONAL_SLASHING_MULTIPLIER_ALTAIR: number;
}
