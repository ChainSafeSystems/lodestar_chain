import {phase0} from "../../../types/lib";

export function getEmptyBlockProcess(): BlockProcess {
  return {
    increaseBalanceCache: null,
    blockRootCache: new Map<phase0.Slot, phase0.Root>(),
    validatorExitCache: {},
  };
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export interface BlockProcess {
  increaseBalanceCache: Map<phase0.ValidatorIndex, phase0.Gwei> | null;
  blockRootCache: Map<phase0.Slot, phase0.Root>;
  validatorExitCache: {
    exitQueueEpoch?: number;
    exitQueueChurn?: number;
    churnLimit?: number;
  };
}
