import {SLOTS_PER_EPOCH} from "@chainsafe/lodestar-params";
import {phase0} from "@chainsafe/lodestar-types";
import {getDevBeaconNode} from "../utils/node/beacon";
import {waitForEvent} from "../utils/events/resolver";
import {getAndInitDevValidators} from "../utils/node/validator";
import {ChainEvent} from "../../src/chain";
import {RestApiOptions} from "../../src/api/rest";
import {testLogger, TestLoggerOpts, LogLevel} from "../utils/logger";
import {initBLS} from "@chainsafe/lodestar-cli/src/util";
import {IChainConfig} from "@chainsafe/lodestar-config";
import {fetchWeakSubjectivityState} from "@chainsafe/lodestar-cli/src/networks";
import {config} from "@chainsafe/lodestar-config/default";
import {connect} from "../utils/network";
import {Network} from "../../src/network";
import {assert} from "chai";

/* eslint-disable no-console, @typescript-eslint/naming-convention */
describe("Start from WSS", function () {
  const testParams: Pick<IChainConfig, "SECONDS_PER_SLOT"> = {
    SECONDS_PER_SLOT: 2,
  };

  before(async function () {
    await initBLS();
  });

  it("using another node", async function () {
    // Should reach justification in 3 epochs max, and finalization in 4 epochs max
    const expectedEpochsToFinish = 4;
    // 1 epoch of margin of error
    const epochsOfMargin = 1;
    const timeoutSetupMargin = 5 * 1000; // Give extra 5 seconds of margin

    // delay a bit so regular sync sees it's up to date and sync is completed from the beginning
    const genesisSlotsDelay = 3;

    const timeout =
      ((epochsOfMargin + expectedEpochsToFinish) * SLOTS_PER_EPOCH + genesisSlotsDelay) *
      testParams.SECONDS_PER_SLOT *
      1000;

    this.timeout(timeout + 2 * timeoutSetupMargin);

    const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * testParams.SECONDS_PER_SLOT;

    const testLoggerOpts: TestLoggerOpts = {logLevel: LogLevel.info};
    const loggerNodeA = testLogger("Node-A", testLoggerOpts);
    const loggerNodeB = testLogger("Node-B", {logLevel: LogLevel.debug});

    const bn = await getDevBeaconNode({
      params: {...testParams, ALTAIR_FORK_EPOCH: Infinity},
      options: {
        api: {
          rest: {enabled: true, api: ["debug"]} as RestApiOptions,
        },
        sync: {isSingleNode: true},
      },
      validatorCount: 32,
      logger: loggerNodeA,
      genesisTime,
    });

    const finalizedEventistener = waitForEvent<phase0.Checkpoint>(bn.chain.emitter, ChainEvent.finalized, timeout);
    const validators = await getAndInitDevValidators({
      node: bn,
      validatorsPerClient: 32,
      validatorClientCount: 1,
      startIndex: 0,
      // At least one sim test must use the REST API for beacon <-> validator comms
      useRestApi: true,
      testLoggerOpts: {logLevel: LogLevel.error},
    });

    await Promise.all(validators.map((v) => v.start()));

    try {
      await finalizedEventistener;
      await waitForEvent<phase0.Checkpoint>(bn.chain.emitter, ChainEvent.finalized, timeout);
      console.log("\nNode A finalized\n");
    } catch (e) {
      (e as Error).message = `Node A failed to finalize: ${(e as Error).message}`;
      throw e;
    }

    const url = "http://127.0.0.1:9596/eth/v1/debug/beacon/states/finalized";

    console.log("Fetching weak subjectivity state from " + url);
    const wsState = await fetchWeakSubjectivityState(config, url);
    console.log("Fetched wss state");
    loggerNodeA.mute();
    const bnStartingFromWSS = await getDevBeaconNode({
      params: {...testParams, ALTAIR_FORK_EPOCH: Infinity},
      options: {api: {rest: {enabled: true, port: 9587} as RestApiOptions}, sync: {isSingleNode: true}},
      validatorCount: 32,
      logger: loggerNodeB,
      genesisTime,
      anchorState: wsState,
    });
    const head = await bn.chain.getHeadBlock();
    if (!head) throw Error("First beacon node has no head block");
    const waitForSynced = waitForEvent<phase0.SignedBeaconBlock>(
      bnStartingFromWSS.chain.emitter,
      ChainEvent.block,
      100000,
      (block) => block.message.slot === head.message.slot
    );

    await connect(bnStartingFromWSS.network as Network, bn.network.peerId, bn.network.localMultiaddrs);

    try {
      await waitForSynced;
    } catch (e) {
      assert.fail("Failed to sync to other node in time");
    }
    const genesisBlock = await bnStartingFromWSS.api.beacon.getBlock(0);
    if (!genesisBlock) {
      assert.fail("Failed to backfill sync");
    }
    await bnStartingFromWSS.close();
    await Promise.all(validators.map((v) => v.stop()));
    await bn.close();
  });
});
