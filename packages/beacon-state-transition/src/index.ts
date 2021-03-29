/**
 * @module chain/stateTransition
 */

export * from "./constants";
export * from "./util";

export * as phase0 from "./phase0";
export * as altair from "./altair";

// TODO refactor phase0/fast to be all-fork ready
export {createCachedBeaconState, CachedBeaconState} from "./phase0/fast";