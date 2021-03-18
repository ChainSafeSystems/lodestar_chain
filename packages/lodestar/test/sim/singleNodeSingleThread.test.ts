import {IBeaconParams} from "@chainsafe/lodestar-params";
import {getDevBeaconNode} from "../utils/node/beacon";
import {waitForEvent} from "../utils/events/resolver";
import {phase0} from "@chainsafe/lodestar-types";
import {getDevValidators} from "../utils/node/validator";
import {expect} from "chai";
import {ChainEvent} from "../../src/chain";
import {IRestApiOptions} from "../../src/api/rest/options";
import {testLogger, LogLevel} from "../utils/logger";

describe("Run single node single thread interop validators (no eth1) until checkpoint", function () {
  const timeout = 120 * 1000;
  const testParams: Partial<IBeaconParams> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    SECONDS_PER_SLOT: 2,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    SLOTS_PER_EPOCH: 8,
  };
  const manyValidatorParams: Partial<IBeaconParams> = {
    ...testParams,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    TARGET_AGGREGATORS_PER_COMMITTEE: 1,
  };

  const loggerNodeA = testLogger("Node-A", LogLevel.info);
  const loggerValiA = testLogger("Vali-A", LogLevel.info);

  const testCases: {
    vc: number;
    validators: number;
    event: ChainEvent.justified | ChainEvent.finalized;
    params: Partial<IBeaconParams>;
  }[] = [
    {vc: 8, validators: 8, event: ChainEvent.justified, params: testParams},
    {vc: 8, validators: 8, event: ChainEvent.finalized, params: testParams},
    {vc: 1, validators: 32, event: ChainEvent.justified, params: manyValidatorParams},
  ];

  for (const testCase of testCases) {
    it(`${testCase.vc} vc / ${testCase.validators} validator > until ${testCase.event}`, async function () {
      this.timeout(timeout);
      const bn = await getDevBeaconNode({
        params: testCase.params,
        options: {sync: {minPeers: 0}, api: {rest: {enabled: true} as IRestApiOptions}},
        validatorCount: testCase.vc * testCase.validators,
        logger: loggerNodeA,
      });
      const justificationEventListener = waitForEvent<phase0.Checkpoint>(
        bn.chain.emitter,
        testCase.event,
        timeout - 10 * 1000
      );
      const validators = getDevValidators(bn, testCase.validators, testCase.vc, true, loggerValiA);
      await Promise.all(validators.map((v) => v.start()));
      try {
        await justificationEventListener;
      } catch (e: unknown) {
        await Promise.all(validators.map((v) => v.stop()));
        await bn.close();
        expect(`failed to get event: ${testCase.event}`);
      }
      await Promise.all(validators.map((v) => v.stop()));
      await bn.close();
    });
  }
});
