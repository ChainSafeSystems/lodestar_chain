/**
 * @module network
 */

import {EventEmitter} from "events";
import LibP2p from "libp2p";
import PeerId, {createFromCID} from "peer-id";
import Multiaddr from "multiaddr";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ILogger} from "@chainsafe/lodestar-utils";
import {IBeaconMetrics} from "../metrics";
import {ReqResp, IReqRespOptions} from "./reqresp/reqResp";
import {INetworkOptions} from "./options";
import {INetwork, NetworkEvent, NetworkEventEmitter, PeerSearchOptions} from "./interface";
import {IBeaconChain} from "../chain";
import {MetadataController} from "./metadata";
import {Discv5, Discv5Discovery, ENR} from "@chainsafe/discv5";
import {DiversifyPeersBySubnetTask} from "./tasks/diversifyPeersBySubnetTask";
import {CheckPeerAliveTask} from "./tasks/checkPeerAliveTask";
import {IPeerMetadataStore} from "./peers";
import {Libp2pPeerMetadataStore} from "./peers/metastore";
import {getPeerCountBySubnet} from "./peers/utils";
import {IPeerRpcScoreStore, PeerRpcScoreStore} from "./peers/score";
import {IBeaconDb} from "../db";
import {createTopicValidatorFnMap, Eth2Gossipsub} from "./gossip";

interface ILibp2pModules {
  config: IBeaconConfig;
  libp2p: LibP2p;
  logger: ILogger;
  metrics?: IBeaconMetrics;
  chain: IBeaconChain;
  db: IBeaconDb;
}

export class Network extends (EventEmitter as {new (): NetworkEventEmitter}) implements INetwork {
  peerId: PeerId;
  localMultiaddrs!: Multiaddr[];
  reqResp: ReqResp;
  gossip: Eth2Gossipsub;
  metadata: MetadataController;
  peerMetadata: IPeerMetadataStore;
  peerRpcScores: IPeerRpcScoreStore;

  private opts: INetworkOptions;
  private config: IBeaconConfig;
  private libp2p: LibP2p;
  private logger: ILogger;
  private metrics?: IBeaconMetrics;
  private diversifyPeersTask: DiversifyPeersBySubnetTask;
  private checkPeerAliveTask: CheckPeerAliveTask;
  /** To count total number of unique seen peers */
  private seenPeers = new Set();

  constructor(opts: INetworkOptions & IReqRespOptions, {config, libp2p, logger, metrics, chain, db}: ILibp2pModules) {
    super();
    this.opts = opts;
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.peerId = libp2p.peerId;
    this.libp2p = libp2p;
    this.peerMetadata = new Libp2pPeerMetadataStore(this.config, this.libp2p.peerStore.metadataBook);
    this.peerRpcScores = new PeerRpcScoreStore(this.peerMetadata);
    this.reqResp = new ReqResp(
      {config, libp2p, peerMetadata: this.peerMetadata, peerRpcScores: this.peerRpcScores, logger},
      opts
    );
    this.metadata = new MetadataController({}, {config, chain, logger});
    this.gossip = new Eth2Gossipsub({
      config,
      genesisValidatorsRoot: chain.genesisValidatorsRoot,
      libp2p,
      validatorFns: createTopicValidatorFnMap({config, chain, db, logger}),
      logger,
      metrics,
    });
    this.diversifyPeersTask = new DiversifyPeersBySubnetTask(this.config, {
      network: this,
      logger: this.logger,
    });
    this.checkPeerAliveTask = new CheckPeerAliveTask(this.config, {
      network: this,
      logger: this.logger,
    });
  }

  async start(): Promise<void> {
    this.libp2p.connectionManager.on(NetworkEvent.peerConnect, this.emitPeerConnect);
    this.libp2p.connectionManager.on(NetworkEvent.peerDisconnect, this.emitPeerDisconnect);
    await this.libp2p.start();
    this.localMultiaddrs = this.libp2p.multiaddrs;
    this.reqResp.start();
    const enr = this.getEnr();
    this.metadata.start(enr!);
    this.gossip.start();
    this.diversifyPeersTask.start();
    const multiaddresses = this.libp2p.multiaddrs.map((m) => m.toString()).join(",");
    this.logger.info(`PeerId ${this.libp2p.peerId.toB58String()}, Multiaddrs ${multiaddresses}`);
  }

  async stop(): Promise<void> {
    this.libp2p.connectionManager.removeListener(NetworkEvent.peerConnect, this.emitPeerConnect);
    this.libp2p.connectionManager.removeListener(NetworkEvent.peerDisconnect, this.emitPeerDisconnect);
    await Promise.all([this.diversifyPeersTask.stop(), this.checkPeerAliveTask.stop()]);
    this.metadata.stop();
    this.gossip.stop();
    this.reqResp.stop();
    await this.libp2p.stop();
  }

  async handleSyncCompleted(): Promise<void> {
    await Promise.all([this.checkPeerAliveTask.start(), this.diversifyPeersTask.handleSyncCompleted()]);
  }

  getEnr(): ENR | undefined {
    const discv5Discovery = this.libp2p._discovery.get("discv5") as Discv5Discovery;
    return discv5Discovery?.discv5?.enr ?? undefined;
  }

  getConnectionsByPeer(): Map<string, LibP2pConnection[]> {
    return this.libp2p.connectionManager.connections;
  }

  /**
   * Get connected peers.
   * @param opts PeerSearchOptions
   */
  getPeers(opts: Partial<PeerSearchOptions> = {}): LibP2p.Peer[] {
    const peerIdStrs = Array.from(this.libp2p.connectionManager.connections.keys());
    const peerIds = peerIdStrs
      .map((peerIdStr) => createFromCID(peerIdStr))
      .filter((peerId) => this.getPeerConnection(peerId));
    const peers = peerIds
      .map((peerId) => this.libp2p.peerStore.get(peerId))
      .filter((peer) => {
        if (!peer) return false;
        if (opts?.supportsProtocols) {
          const supportsProtocols = opts.supportsProtocols;
          this.logger.debug("Peer supported protocols", {
            id: peer.id.toB58String(),
            protocols: peer.protocols,
          });
          for (const protocol of supportsProtocols) {
            if (!peer.protocols.includes(protocol)) {
              return false;
            }
          }
          return true;
        }
        return true;
      }) as LibP2p.Peer[];

    return peers.slice(0, opts?.count ?? peers.length) || [];
  }

  getMaxPeer(): number {
    return this.opts.maxPeers;
  }

  hasPeer(peerId: PeerId, connected = false): boolean {
    const peer = this.libp2p.peerStore.get(peerId);
    if (!peer) {
      return false;
    }

    if (connected) {
      const conn = this.getPeerConnection(peerId);
      if (!conn || conn.stat.status !== "open") {
        return false;
      }
    }

    return true;
  }

  getPeerConnection(peerId: PeerId): LibP2pConnection | null {
    return this.libp2p.connectionManager.get(peerId);
  }

  async connect(peerId: PeerId, localMultiaddrs?: Multiaddr[]): Promise<void> {
    if (localMultiaddrs) {
      this.libp2p.peerStore.addressBook.add(peerId, localMultiaddrs);
    }

    await this.libp2p.dial(peerId);
  }

  async disconnect(peerId: PeerId): Promise<void> {
    try {
      await this.libp2p.hangUp(peerId);
    } catch (e: unknown) {
      this.logger.warn("Unclean disconnect", {reason: e.message});
    }
  }

  async searchSubnetPeers(subnets: string[]): Promise<void> {
    const connectedPeerIds = this.getPeers().map((peer) => peer.id);

    const peerCountBySubnet = getPeerCountBySubnet(connectedPeerIds, this.peerMetadata, subnets);
    for (const [subnetStr, count] of peerCountBySubnet) {
      if (count === 0) {
        // the validator must discover new peers on this topic
        this.logger.verbose("Finding new peers", {subnet: subnetStr});
        const found = await this.connectToNewPeersBySubnet(parseInt(subnetStr));
        if (found) {
          this.logger.verbose("Found new peer", {subnet: subnetStr});
        } else {
          this.logger.verbose("Not found any peers", {subnet: subnetStr});
        }
      }
    }
  }

  /**
   * Connect to 1 new peer given a subnet.
   * @param subnet the subnet calculated from committee index
   */
  private async connectToNewPeersBySubnet(subnet: number): Promise<boolean> {
    const discv5Peers = (await this.searchDiscv5Peers(subnet)) || [];
    // we don't want to connect to known peers
    const candidatePeers = discv5Peers.filter(
      (peer) => !this.libp2p.peerStore.addressBook.getMultiaddrsForPeer(peer.peerId)
    );

    let found = false;
    for (const peer of candidatePeers) {
      // will automatically get metadata once we connect
      try {
        await this.connect(peer.peerId, [peer.multiaddr]);
        found = true;
        break;
      } catch (e: unknown) {
        // this runs too frequently so make it verbose
        this.logger.verbose("Cannot connect to peer", {peerId: peer.peerId.toB58String(), subnet, error: e.message});
      }
    }

    return found;
  }

  private searchDiscv5Peers = async (subnet: number): Promise<{peerId: PeerId; multiaddr: Multiaddr}[]> => {
    const discovery: Discv5Discovery = this.libp2p._discovery.get("discv5") as Discv5Discovery;
    const discv5: Discv5 = discovery.discv5;

    return await Promise.all(
      discv5
        .kadValues()
        .filter((enr: ENR) => enr.get("attnets"))
        .filter((enr: ENR) => {
          try {
            return this.config.types.phase0.AttestationSubnets.deserialize(enr.get("attnets")!)[subnet];
          } catch (err) {
            return false;
          }
        })
        .map((enr: ENR) =>
          enr.peerId().then((peerId) => {
            return {peerId, multiaddr: enr.getLocationMultiaddr("tcp")!};
          })
        )
    );
  };

  private emitPeerConnect = (conn: LibP2pConnection): void => {
    this.logger.verbose("peer connected", {peerId: conn.remotePeer.toB58String(), direction: conn.stat.direction});

    // tmp fix, we will just do double status exchange but nothing major
    // TODO: fix it?
    this.emit(NetworkEvent.peerConnect, conn.remotePeer, conn.stat.direction);
    this.metrics?.peerConnectedEvent.inc({direction: conn.stat.direction});
    this.runPeerCountMetrics();

    this.seenPeers.add(conn.remotePeer.toB58String());
    this.metrics?.peersTotalUniqueConnected.set(this.seenPeers.size);
  };

  private emitPeerDisconnect = (conn: LibP2pConnection): void => {
    this.logger.verbose("peer disconnected", {peerId: conn.remotePeer.toB58String()});

    this.emit(NetworkEvent.peerDisconnect, conn.remotePeer);
    this.metrics?.peerDisconnectedEvent.inc({direction: conn.stat.direction});
    this.runPeerCountMetrics();
  };

  /** Register peer count metrics */
  private runPeerCountMetrics(): void {
    let total = 0;
    const peersByDirection = new Map<string, number>();
    for (const connections of this.libp2p.connectionManager.connections.values()) {
      const cnx = connections.find((cnx) => cnx.stat.status === "open");
      if (cnx) {
        const direction = cnx.stat.direction;
        peersByDirection.set(direction, 1 + (peersByDirection.get(direction) ?? 0));
        total++;
      }
    }

    for (const [direction, peers] of peersByDirection.entries()) {
      this.metrics?.peersByDirection.set({direction}, peers);
    }

    this.metrics?.peers.set(total);
  }
}
