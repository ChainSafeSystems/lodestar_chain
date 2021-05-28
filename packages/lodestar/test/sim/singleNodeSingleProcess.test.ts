import {IBeaconParams} from "@chainsafe/lodestar-params";
import {phase0} from "@chainsafe/lodestar-types";
import {getDevBeaconNode} from "../utils/node/beacon";
import {waitForEvent} from "../utils/events/resolver";
import {getAndInitDevValidators} from "../utils/node/validator";
import {ChainEvent} from "../../src/chain";
import {RestApiOptions} from "../../src/api/rest";
import {testLogger, TestLoggerOpts, LogLevel} from "../utils/logger";
import {logFilesDir} from "./params";
import {simTestInfoTracker} from "../utils/node/simTest";
import {sleep, TimestampFormatCode} from "@chainsafe/lodestar-utils";
import {initBLS} from "@chainsafe/lodestar-cli/src/util";

/* eslint-disable no-console, @typescript-eslint/naming-convention */

describe("Run single node single process interop validators (no eth1) until checkpoint", function () {
  const testParams: Pick<IBeaconParams, "SECONDS_PER_SLOT" | "SLOTS_PER_EPOCH" | "TARGET_AGGREGATORS_PER_COMMITTEE"> = {
    SECONDS_PER_SLOT: 2,
    SLOTS_PER_EPOCH: 8,
    // Reduce from 16 of minimal but ensure there's almost always an aggregator per committee
    // otherwise block producers won't be able to include attestations
    TARGET_AGGREGATORS_PER_COMMITTEE: 4,
  };

  before(async function () {
    await initBLS();
  });

  const testCases: {
    validatorClientCount: number;
    validatorsPerClient: number;
    event: ChainEvent.justified | ChainEvent.finalized;
    altairForkEpoch: number;
  }[] = [
    // phase0 fork only
    {validatorClientCount: 1, validatorsPerClient: 32, event: ChainEvent.justified, altairForkEpoch: Infinity},
    {validatorClientCount: 1, validatorsPerClient: 32, event: ChainEvent.finalized, altairForkEpoch: Infinity},
    // altair fork only
    {validatorClientCount: 1, validatorsPerClient: 32, event: ChainEvent.finalized, altairForkEpoch: 0},
    // altair fork at epoch 1
    {validatorClientCount: 1, validatorsPerClient: 32, event: ChainEvent.finalized, altairForkEpoch: 1},
    // altair fork at epoch 2
    {validatorClientCount: 1, validatorsPerClient: 32, event: ChainEvent.finalized, altairForkEpoch: 2},
  ];

  for (const {validatorClientCount, validatorsPerClient, event, altairForkEpoch} of testCases) {
    it(`singleNode ${validatorClientCount} vc / ${validatorsPerClient} validator > until ${event}, altairForkEpoch ${altairForkEpoch}`, async function () {
      // Should reach justification in 3 epochs max, and finalization in 4 epochs max
      const expectedEpochsToFinish = event === ChainEvent.justified ? 3 : 4;
      // 1 epoch of margin of error
      const epochsOfMargin = 1;
      const timeoutSetupMargin = 5 * 1000; // Give extra 5 seconds of margin

      // delay a bit so regular sync sees it's up to date and sync is completed from the beginning
      const genesisSlotsDelay = 3;

      const timeout =
        ((epochsOfMargin + expectedEpochsToFinish) * testParams.SLOTS_PER_EPOCH + genesisSlotsDelay) *
        testParams.SECONDS_PER_SLOT *
        1000;

      this.timeout(timeout + 2 * timeoutSetupMargin);

      const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * testParams.SECONDS_PER_SLOT;

      const testLoggerOpts: TestLoggerOpts = {
        logLevel: LogLevel.info,
        logFile: `${logFilesDir}/singlethread_singlenode_altair-${altairForkEpoch}_vc-${validatorClientCount}_vs-${validatorsPerClient}_event-${event}.log`,
        timestampFormat: {
          format: TimestampFormatCode.EpochSlot,
          genesisTime,
          slotsPerEpoch: testParams.SLOTS_PER_EPOCH,
          secondsPerSlot: testParams.SECONDS_PER_SLOT,
        },
      };
      const loggerNodeA = testLogger("Node-A", testLoggerOpts);

      const bn = await getDevBeaconNode({
        params: {...testParams, ALTAIR_FORK_EPOCH: altairForkEpoch},
        options: {api: {rest: {enabled: true} as RestApiOptions}, sync: {isSingleNode: true}},
        validatorCount: validatorClientCount * validatorsPerClient,
        logger: loggerNodeA,
        genesisTime,
      });

      const stopInfoTracker = simTestInfoTracker(bn, loggerNodeA);

      const justificationEventListener = waitForEvent<phase0.Checkpoint>(bn.chain.emitter, event, timeout);
      const validators = await getAndInitDevValidators({
        node: bn,
        validatorsPerClient,
        validatorClientCount,
        startIndex: 0,
        // At least one sim test must use the REST API for beacon <-> validator comms
        useRestApi: true,
        testLoggerOpts,
      });

      await Promise.all(validators.map((v) => v.start()));

      try {
        await justificationEventListener;
        console.log(`\nGot event ${event}, stopping validators and nodes\n`);
      } catch (e) {
        (e as Error).message = `failed to get event: ${event}: ${(e as Error).message}`;
        throw e;
      } finally {
        await Promise.all(validators.map((v) => v.stop()));

        // wait for 1 slot
        await sleep(1 * bn.config.params.SECONDS_PER_SLOT * 1000);
        stopInfoTracker();
        await bn.close();
        console.log("\n\nDone\n\n");
        await sleep(1000);
      }
    });
  }
});
