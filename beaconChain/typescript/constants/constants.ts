// https://github.com/ethereum/eth2.0-specs/blob/master/specs/core/0_beacon-chain.md#constants
// TODO Update TBD
// TODO Explain what each constant does

export default {
  SHARD_COUNT: 1024,
  DEPOSIT_SIZE: 32,
  MIN_ONLINE_DEPOSIT_SIZE: 16,
  GWEI_PER_ETH: 1000000000,
  MIN_COMMITTEE_SIZE: 128,
  GENESIS_TIME: "TBD",
  SLOT_DURATION: 16,
  CYCLE_LENGTH: 64,
  MIN_VALIDATOR_SET_CHANGE_INTERVAL: 256,
  RANDAO_SLOTS_PER_LAYER: 4096,
  SQRT_E_DROP_TIME: 65536,
  WITHDRAWAL_PERIOD: 524288,
  BASE_REWARD_QUOTIENT: 32768,
  MAX_VALIDATOR_CHURN_QUOTIENT: 32,
  LOGOUT_MESSAGE: "LOGOUT",
  INITIAL_FORK_VERSION: 0
};
