import {IBeaconParams} from "@chainsafe/lodestar-params";
import {Network} from "../../src/network";
import {getDevBeaconNode} from "../utils/node/beacon";
import {waitForEvent} from "../utils/events/resolver";
import {phase0} from "@chainsafe/lodestar-types";
import {getAndInitDevValidators} from "../utils/node/validator";
import {Validator} from "@chainsafe/lodestar-validator/lib";
import {BeaconNode} from "../../src/node";
import {ChainEvent} from "../../src/chain";
import {testLogger, LogLevel, TestLoggerOpts} from "../utils/logger";
import {connect} from "../utils/network";
import {logFilesDir} from "./params";
import {simTestInfoTracker} from "../utils/node/simTest";
import {ILogger, sleep, TimestampFormatCode} from "@chainsafe/lodestar-utils";

/* eslint-disable no-console, @typescript-eslint/naming-convention */

describe("Run multi node single process interop validators (no eth1) until checkpoint", function () {
  const testParams: Pick<IBeaconParams, "SECONDS_PER_SLOT" | "SLOTS_PER_EPOCH"> = {
    SECONDS_PER_SLOT: 3,
    SLOTS_PER_EPOCH: 8,
  };

  const testCases: {
    nodeCount: number;
    validatorsPerNode: number;
    event: ChainEvent.justified | ChainEvent.finalized;
    altairForkEpoch: number;
  }[] = [
    // Test phase0 to justification
    {nodeCount: 4, validatorsPerNode: 8, event: ChainEvent.justified, altairForkEpoch: Infinity},
    // Test altair only
    {nodeCount: 4, validatorsPerNode: 8, event: ChainEvent.justified, altairForkEpoch: 0},
    // Test phase -> altair fork transition
    {nodeCount: 4, validatorsPerNode: 8, event: ChainEvent.justified, altairForkEpoch: 2},
  ];

  let onDoneHandlers: (() => Promise<void>)[] = [];

  for (const {nodeCount, validatorsPerNode, event, altairForkEpoch} of testCases) {
    it(`single process ${nodeCount} nodes / ${validatorsPerNode} vc / 1 validator > until ${event}, altairForkEpoch ${altairForkEpoch}`, async function () {
      this.timeout("10 min");

      const nodes: BeaconNode[] = [];
      const validators: Validator[] = [];
      const loggers: ILogger[] = [];
      // delay a bit so regular sync sees it's up to date and sync is completed from the beginning
      const genesisSlotsDelay = 3;
      const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * testParams.SECONDS_PER_SLOT;

      for (let i = 0; i < nodeCount; i++) {
        const testLoggerOpts: TestLoggerOpts = {
          logLevel: LogLevel.info,
          logFile: `${logFilesDir}/singleprocess_multinode_altair-${altairForkEpoch}.log`,
          timestampFormat: {
            format: TimestampFormatCode.EpochSlot,
            genesisTime,
            slotsPerEpoch: testParams.SLOTS_PER_EPOCH,
            secondsPerSlot: testParams.SECONDS_PER_SLOT,
          },
        };
        const logger = testLogger(`Node ${i}`, testLoggerOpts);

        const node = await getDevBeaconNode({
          params: {...testParams, ALTAIR_FORK_EPOCH: altairForkEpoch},
          validatorCount: nodeCount * validatorsPerNode,
          genesisTime,
          logger,
        });

        const nodeValidators = await getAndInitDevValidators({
          node,
          validatorsPerClient: validatorsPerNode,
          validatorClientCount: 1,
          startIndex: i * validatorsPerNode,
          testLoggerOpts,
        });

        loggers.push(logger);
        nodes.push(node);
        validators.push(...nodeValidators);
      }

      const stopInfoTracker = simTestInfoTracker(nodes[0], loggers[0]);

      onDoneHandlers.push(async () => {
        await Promise.all(validators.map((validator) => validator.stop()));
        console.log("--- Stopped all validators ---");
        // wait for 1 slot
        await sleep(1 * testParams.SECONDS_PER_SLOT * 1000);

        stopInfoTracker();
        await Promise.all(nodes.map((node) => node.close()));
        console.log("--- Stopped all nodes ---");
        // Wait a bit for nodes to shutdown
        await sleep(3000);
      });

      // Connect all nodes with each other
      for (let i = 0; i < nodeCount; i++) {
        for (let j = 0; j < nodeCount; j++) {
          if (i !== j) {
            await connect(nodes[i].network as Network, nodes[j].network.peerId, nodes[j].network.localMultiaddrs);
          }
        }
      }

      // Start all validators at once.
      await Promise.all(validators.map((validator) => validator.start()));

      // Wait for justified checkpoint on all nodes
      await Promise.all(nodes.map((node) => waitForEvent<phase0.Checkpoint>(node.chain.emitter, event, 240000)));
      console.log("--- All nodes reached justified checkpoint ---");
    });
  }

  afterEach("Stop nodes and validators", async function () {
    this.timeout(20000);
    for (const onDoneHandler of onDoneHandlers) {
      await onDoneHandler();
    }
    onDoneHandlers = [];
  });
});
