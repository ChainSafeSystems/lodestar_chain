import path from "path";
import os from "os";
import fs from "fs";
import tmp from "tmp";
import child_process from "child_process";
import PeerId, {createFromPrivKey} from "peer-id";
import {AbortController} from "abort-controller";
import {ENR, createKeypairFromPeerId} from "@chainsafe/discv5";
import {IBeaconParams} from "@chainsafe/lodestar-params";
import {params as minimalParams} from "@chainsafe/lodestar-params/minimal";
import {RecursivePartial, TimeoutError, withTimeout} from "@chainsafe/lodestar-utils";
import {createIBeaconConfig} from "@chainsafe/lodestar-config";
import {getClient, Api, routes} from "@chainsafe/lodestar-api";
import {ChainEvent} from "../../src/chain";
import {IBeaconNodeOptions} from "../../src";
import {retry} from "../../src/util/retry";
import {getInteropState, storeSSZState} from "../../src/node/utils/state";
import {logFilesDir} from "./params";

// TODO: Add simTestInfoTracker() to node 0.
//       Probably that would have to be bundled in the packages/cli or packages/lodestar

/* eslint-disable no-console, @typescript-eslint/naming-convention */

const lodestarBinPath = path.join(__dirname, "../../../cli/bin/lodestar");
const nodeJsBinPath = process.execPath;

describe("Run multi node multi process interop validators (no eth1) until checkpoint", function () {
  // Test phase0 to justification
  const phase0Case = {altairForkEpoch: 1e10}; // Practically Infinity
  // Test altair only
  const altairGenCase = {altairForkEpoch: 0};
  // Test phase -> altair fork transition
  const altairEph2Case = {altairForkEpoch: 2};

  const {RUN_ONLY_SIM_TEST} = process.env;
  const testCases =
    RUN_ONLY_SIM_TEST === "phase0"
      ? [phase0Case]
      : RUN_ONLY_SIM_TEST === "altair-genesis"
      ? [altairGenCase]
      : RUN_ONLY_SIM_TEST === "altair-epoch2"
      ? [altairEph2Case]
      : // if RUN_ONLY_SIM_TEST is not set or else run all tests
        [phase0Case, altairGenCase, altairEph2Case];

  const afterEachCallbacks: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (afterEachCallbacks.length > 0) {
      const callback = afterEachCallbacks.pop();
      if (callback) await callback();
    }
  });

  for (const testCase of testCases) {
    const nodeCount = 4;
    const validatorsPerNode = 8;
    const event = ChainEvent.justified;
    const altairForkEpoch = testCase.altairForkEpoch;

    it(`multiProcess ${nodeCount} nodes / ${validatorsPerNode} vc / 1 validator > until ${event}, altairForkEpoch ${altairForkEpoch}`, async function () {
      this.timeout("10 min");

      console.log(
        "OS CPUs",
        os.cpus().map((cpu) => cpu.model)
      );

      const preset = "minimal";
      const params: Pick<IBeaconParams, "SECONDS_PER_SLOT" | "SLOTS_PER_EPOCH" | "ALTAIR_FORK_EPOCH"> = {
        SECONDS_PER_SLOT: 2,
        SLOTS_PER_EPOCH: 8,
        ALTAIR_FORK_EPOCH: altairForkEpoch,
      };

      // delay a bit so regular sync sees it's up to date and sync is completed from the beginning
      // When running multi-thread each thread has to compile the entire codebase from Typescript
      // so it takes a long time before each node is started
      const genesisSlotsDelay = 30;
      const genesisTime = Math.floor(Date.now() / 1000) + genesisSlotsDelay * params.SECONDS_PER_SLOT;

      // CLI options
      const tmpDir = tmp.dirSync({unsafeCleanup: true});
      const logFile = `${logFilesDir}/multiprocess_multinode_altair-${altairForkEpoch}.log`;
      const logLevelFile = "debug";
      const genesisStateFilePath = path.join(tmpDir.name, "genesis_state.ssz");
      const paramsFilePath = path.join(tmpDir.name, "config.yaml");

      // We need to create a common genesis state for all nodes, and persist it to disk
      const config = createIBeaconConfig({...minimalParams, ...params});
      const validatorCount = nodeCount * validatorsPerNode;
      const {state: genesisState} = await getInteropState(config, validatorCount, genesisTime);
      await storeSSZState(config, genesisState, genesisStateFilePath);

      // Persist same params for all nodes. Note JSON is a subset of YAML
      fs.writeFileSync(paramsFilePath, JSON.stringify(params, null, 2));

      const peerIds: PeerId[] = [];
      const enrs: string[] = [];
      const clients: Api[] = [];
      const processByNodes: {
        node: child_process.ChildProcessByStdio<null, null, null>;
        vali: child_process.ChildProcessByStdio<null, null, null>;
      }[] = [];

      const getP2pPort = (i: number): number => 12010 + i;
      const getApiPort = (i: number): number => 11010 + i;
      const getNodeApi = (i: number): string => `http://127.0.0.1:${getApiPort(i)}`;
      const getP2pAddr = (i: number): string => `/ip4/127.0.0.1/tcp/${getP2pPort(i)}`;
      const peerIdPrivKeys = [
        "08021220bcb271bf5b26696389c9199e71c30544e5a39e542bc283d78ed3bcc22bce58f2",
        "080212204702ac19b892b66c3eddbe3ea91f5088d52cf452485f16eaa0e93ae2bbf97e80",
        "0802122091282cbc7d27d0e5b5bde6b87be2a3b7ab9954cc49c3c4955d584fff98c6c892",
        "080212207e1b18a94e922a195523aa13ba5a17291d48c72d820c34b3849d9c17958e55bb",
      ];
      const getPeerId = (i: number): Promise<PeerId> => createFromPrivKey(Buffer.from(peerIdPrivKeys[i], "hex"));

      // First pre-compute the peerIds and ENRs to pre-distribute their ENRs to other nodes
      for (let i = 0; i < nodeCount; i++) {
        const p2pPort = getP2pPort(i);
        const peerId = await getPeerId(i);
        const keypair = createKeypairFromPeerId(peerId);
        const enr = ENR.createV4(keypair.publicKey);
        enr.ip = "127.0.0.1";
        enr.udp = p2pPort;
        enr.tcp = p2pPort;
        enrs[i] = enr.encodeTxt(keypair.privateKey);
        peerIds[i] = peerId;

        clients[i] = getClient(config, {baseUrl: getNodeApi(i)});
      }

      for (let i = 0; i < nodeCount; i++) {
        const rootDirNode = path.join(tmpDir.name, `node-${i}`);
        const rootDirVali = path.join(tmpDir.name, `vali-${i}`);
        const configFilePath = path.join(rootDirNode, "beacon.config.json");
        const peerIdFilePath = path.join(rootDirNode, "peer-id.json");
        const p2pPort = getP2pPort(i);
        const apiPort = getApiPort(i); // Deterministic port for --server option
        const nodeApi = getNodeApi(i);

        // Create common beaconNodeOptions for all nodes
        const options: RecursivePartial<IBeaconNodeOptions> = {
          api: {
            rest: {
              enabled: true,
              port: apiPort,
              // Default namespaces -------------------------------- | + To connect to peers
              api: ["beacon", "config", "events", "node", "validator", "debug"],
            },
          },
          chain: {
            runChainStatusNotifier: true,
          },
          eth1: {enabled: false},
          metrics: {enabled: false},
          network: {
            disablePeerDiscovery: true,
            localMultiaddrs: [`/ip4/127.0.0.1/tcp/${p2pPort}`],
            discv5: {
              bindAddr: `/ip4/127.0.0.1/udp/${p2pPort}`,
              enabled: false,
              // Immutably splice item i from enrs array
              bootEnrs: [...enrs.slice(0, i), ...enrs.slice(i + 1)],
            },
          },
        };

        fs.mkdirSync(rootDirNode, {recursive: true});
        fs.mkdirSync(rootDirVali, {recursive: true});
        fs.writeFileSync(configFilePath, JSON.stringify(options, null, 2));
        // Persist peerId to have the expected privKey so the bootEnrs are valid
        fs.writeFileSync(peerIdFilePath, JSON.stringify(peerIds[i].toJSON(), null, 2));

        // Spawn tuple of processes (proc) per node: node + validator (vali)
        // All nodes have to have common:
        // - genesisTime
        // - options
        // - params

        const nodeProc = child_process.spawn(
          nodeJsBinPath,
          [
            lodestarBinPath,
            "beacon",
            ...toArgs({
              preset: preset,
              rootDir: rootDirNode,
              logFile: logFile,
              logLevelFile: logLevelFile,
              logFormatGenesisTime: genesisTime,
              logFormatId: `node-${i}`,
              genesisStateFile: genesisStateFilePath,
              configFile: configFilePath,
              paramsFile: paramsFilePath,
              peerIdFile: peerIdFilePath,
            }),
          ],
          {stdio: ["inherit", "inherit", "inherit"]}
        );

        // Write the keys to validate to some directory as cheap keystores
        const keystoresDir = path.join(rootDirVali, "keystores");
        const secretsDir = path.join(rootDirVali, "secretsDir");
        const startIndex = i * validatorsPerNode;
        const endIndex = startIndex + validatorsPerNode - 1;

        const valiProc = child_process.spawn(
          nodeJsBinPath,
          [
            lodestarBinPath,
            "validator",
            ...toArgs({
              preset: preset,
              rootDir: rootDirVali,
              logFile: logFile,
              logLevelFile: logLevelFile,
              logFormatGenesisTime: genesisTime,
              logFormatId: `vali-${i}`,
              paramsFile: paramsFilePath,
              keystoresDir: keystoresDir,
              secretsDir: secretsDir,
              server: nodeApi,
              interopIndexes: `${startIndex}..${endIndex}`,
            }),
          ],
          {stdio: ["inherit", "inherit", "inherit"]}
        );

        processByNodes.push({node: nodeProc, vali: valiProc});
      }

      // On error and success kill all processes
      process.on("SIGINT", () => {
        const procs = processByNodes.map((p) => [p.node, p.vali]).flat();
        for (const proc of procs) proc.kill("SIGKILL");
        console.log("On parent SIGINT: Killed all child processes");
      });
      afterEachCallbacks.push(async () => {
        try {
          const procs = processByNodes.map((p) => [p.node, p.vali]).flat();
          for (const proc of procs) proc.kill("SIGKILL");
          console.log("afterEach(): Killed all child processes");
        } catch (e) {
          console.error("Error terminating processes", e);
        }
      });
      console.log("Registered afterEachCallbacks");

      const controller = new AbortController();
      afterEachCallbacks.push(() => controller.abort());

      /** Run `fn()` ensuring it resolves before genesis */
      async function runBeforeGenesis(action: string, fn: () => Promise<void>): Promise<void> {
        await withTimeout(fn, genesisTime * 1000 - Date.now(), controller.signal).catch((e: Error) => {
          if (e instanceof TimeoutError) {
            throw Error(`Not able to ${action} before genesis`);
          } else {
            throw e;
          }
        });
      }

      // Wait for all nodes to start
      await runBeforeGenesis("start nodes network", async () => {
        for (let i = 0; i < nodeCount; i++) {
          await retry(
            async () => {
              const res = await clients[i].node.getNetworkIdentity();
              console.log(`Node ${i} is online`, res.data.peerId);
            },
            {
              retries: 15,
              waitBetweenRetriesMs: 2000,
              onError: (e, k) => console.error(`Node ${i} not available yet, try ${k}`, e.message),
            }
          );
        }
      });

      // Connect all nodes with others
      await runBeforeGenesis("connect all nodes", async () => {
        for (let i = 0; i < nodeCount; i++) {
          for (let j = 0; j < nodeCount; j++) {
            if (i === j) continue;
            await retry(
              async () => {
                await clients[i].debug.connectToPeer(peerIds[j].toB58String(), [getP2pAddr(j)]);
                console.log(`Successfully connected nodes ${i} -> ${j}`);
              },
              {
                retries: 5,
                waitBetweenRetriesMs: 2000,
                // Connecting to nodes should work the first time. Log otherwise why it fails
                onError: (e, k) => console.error(`Error connectToPeer node ${i} -> ${j}, try ${k}`, e),
              }
            );
          }
        }
      });

      // TODO:
      // - Connect all nodes with others
      // - Listen for event and resolve the test
      //

      // Main test run here:
      // - Listen for process failures, and reject the test
      // - Wait for the checkpoint event subscribing to the events API
      // - If neither condition is reached, the mocha timeout will fail the test

      await Promise.all(
        processByNodes.map((processByNode, i) => {
          return new Promise<void>((resolve, reject) => {
            for (const [id, proc] of Object.entries(processByNode)) {
              proc.on("close", (code) => {
                console.log(`${i} ${id} exited with code ${code}`);
                // exit code = 0 is bad, node should not stop on its own
                reject(Error(`Process ${i} exit code ${code}`));
              });

              proc.on("error", (err) => {
                console.log(`${i} ${id} error event`, err);
                reject(err);
              });
            }

            // Wait for finalized checkpoint on all nodes
            clients[i].events.eventstream([routes.events.EventType.head], controller.signal, (event) => {
              if (event.type === routes.events.EventType.head) {
                if (event.message.slot > config.params.SLOTS_PER_EPOCH * 3) {
                  console.log(`TEMP: BeaconNode #${i} got to epoch 3`, {
                    root: event.message.block,
                  });
                  resolve();
                }
              }
            });
          });
        })
      );

      console.log("\n\n### Test completed\n\n");
    });
  }
});

function toArgs(obj: Record<string, string | number>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    args.push(`--${key}=${value}`);
  }
  return args;
}
