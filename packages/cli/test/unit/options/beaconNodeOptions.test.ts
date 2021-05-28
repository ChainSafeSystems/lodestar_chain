import {expect} from "chai";
import {IBeaconNodeOptions} from "@chainsafe/lodestar";
import {LogLevel, RecursivePartial} from "@chainsafe/lodestar-utils";
import {parseBeaconNodeArgs, IBeaconNodeArgs} from "../../../src/options/beaconNodeOptions";

describe("options / beaconNodeOptions", () => {
  it("Should parse BeaconNodeArgs", () => {
    // Cast to match the expected fully defined type
    const beaconNodeArgsPartial = {
      "api.rest.api": [],
      "api.rest.cors": "*",
      "api.rest.enabled": true,
      "api.rest.host": "127.0.0.1",
      "api.rest.port": 7654,

      "chain.runChainStatusNotifier": true,
      "chain.useSingleThreadVerifier": true,

      "eth1.enabled": true,
      "eth1.providerUrl": "http://my.node:8545",
      "eth1.depositContractDeployBlock": 1625314,

      "logger.eth1.level": "debug",
      "logger.unknown.level": "debug",

      "metrics.enabled": true,
      "metrics.gatewayUrl": "http://localhost:8000",
      "metrics.serverPort": 8765,
      "metrics.timeout": 5000,
      "metrics.listenAddr": "0.0.0.0",

      "network.discv5.enabled": true,
      "network.discv5.bindAddr": "addr",
      "network.discv5.bootEnrs": ["enr:-somedata"],
      "network.maxPeers": 30,
      "network.targetPeers": 25,
      "network.bootMultiaddrs": [],
      "network.localMultiaddrs": [],

      "sync.isSingleNode": true,
    } as IBeaconNodeArgs;

    const expectedOptions: RecursivePartial<IBeaconNodeOptions> = {
      api: {
        rest: {
          api: [],
          cors: "*",
          enabled: true,
          host: "127.0.0.1",
          port: 7654,
        },
      },
      chain: {
        runChainStatusNotifier: true,
        useSingleThreadVerifier: true,
      },
      eth1: {
        enabled: true,
        providerUrl: "http://my.node:8545",
        depositContractDeployBlock: 1625314,
      },
      logger: {
        eth1: {
          level: LogLevel.debug,
        },
      },
      metrics: {
        enabled: true,
        gatewayUrl: "http://localhost:8000",
        serverPort: 8765,
        timeout: 5000,
        listenAddr: "0.0.0.0",
      },
      network: {
        discv5: {
          enabled: true,
          bindAddr: "addr",
          bootEnrs: ["enr:-somedata"],
        },
        maxPeers: 30,
        targetPeers: 25,
        bootMultiaddrs: [],
        localMultiaddrs: [],
      },
      sync: {
        isSingleNode: true,
      },
    };

    const options = parseBeaconNodeArgs(beaconNodeArgsPartial);
    expect(options).to.deep.equal(expectedOptions);
  });
});
