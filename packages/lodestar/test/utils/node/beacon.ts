import deepmerge from "deepmerge";
import tmp from "tmp";
import {createEnr} from "@chainsafe/lodestar-cli/src/config";
import {params as minimalParams} from "@chainsafe/lodestar-params/minimal";
import {createIBeaconConfig} from "@chainsafe/lodestar-config";
import {IBeaconParams} from "@chainsafe/lodestar-params";
import {ILogger, RecursivePartial} from "@chainsafe/lodestar-utils";
import {LevelDbController} from "@chainsafe/lodestar-db";
import {BeaconNode} from "../../../src/node";
import {createNodeJsLibp2p} from "../../../src/network/nodejs";
import {createPeerId} from "../../../src/network";
import {defaultNetworkOptions} from "../../../src/network/options";
import {getInteropState, storeDeposits} from "../../../src/node/utils/state";
import {IBeaconNodeOptions} from "../../../src/node/options";
import {defaultOptions} from "../../../src/node/options";
import {BeaconDb} from "../../../src/db";
import {testLogger} from "../logger";
import PeerId from "peer-id";

export async function getDevBeaconNode({
  params,
  options = {},
  validatorCount,
  genesisTime,
  logger,
  peerId,
  peerStoreDir,
}: {
  params: Partial<IBeaconParams>;
  options?: RecursivePartial<IBeaconNodeOptions>;
  validatorCount: number;
  genesisTime?: number;
  logger?: ILogger;
  peerId?: PeerId;
  peerStoreDir?: string;
}): Promise<BeaconNode> {
  if (!peerId) peerId = await createPeerId();
  const tmpDir = tmp.dirSync({unsafeCleanup: true});
  const config = createIBeaconConfig({...minimalParams, ...params});
  logger = logger ?? testLogger();

  const db = new BeaconDb({config, controller: new LevelDbController({name: tmpDir.name}, {logger})});
  await db.start();

  const libp2p = await createNodeJsLibp2p(
    peerId,
    {
      discv5: {
        enabled: false,
        enr: createEnr(peerId),
        bindAddr: options.network?.discv5?.bindAddr || "/ip4/127.0.0.1/udp/0",
        bootEnrs: [],
      },
      localMultiaddrs: options.network?.localMultiaddrs || ["/ip4/127.0.0.1/tcp/0"],
      targetPeers: defaultNetworkOptions.targetPeers,
      maxPeers: defaultNetworkOptions.maxPeers,
    },
    {disablePeerDiscovery: true, peerStoreDir}
  );

  options = deepmerge(
    defaultOptions,
    deepmerge(
      {
        db: {name: tmpDir.name},
        eth1: {enabled: false},
        metrics: {enabled: false},
        network: {disablePeerDiscovery: true},
      } as Partial<IBeaconNodeOptions>,
      options
    )
  );

  const {state, deposits} = await getInteropState(config, validatorCount, genesisTime);
  await storeDeposits(config, db, deposits);
  return await BeaconNode.init({
    opts: options as IBeaconNodeOptions,
    config,
    db,
    logger,
    libp2p,
    anchorState: state,
  });
}
