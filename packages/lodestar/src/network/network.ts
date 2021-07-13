/**
 * @module network
 */

import LibP2p, {Connection} from "libp2p";
import PeerId from "peer-id";
import Multiaddr from "multiaddr";
import {AbortSignal} from "@chainsafe/abort-controller";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ILogger} from "@chainsafe/lodestar-utils";
import {ATTESTATION_SUBNET_COUNT, ForkName, SYNC_COMMITTEE_SUBNET_COUNT} from "@chainsafe/lodestar-params";
import {Discv5Discovery, ENR} from "@chainsafe/discv5";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {Epoch} from "@chainsafe/lodestar-types";
import {IMetrics} from "../metrics";
import {ChainEvent, IBeaconChain, IBeaconClock} from "../chain";
import {IBeaconDb} from "../db";
import {INetworkOptions} from "./options";
import {INetwork} from "./interface";
import {ReqResp, IReqResp, IReqRespOptions, ReqRespHandlers} from "./reqresp";
import {Eth2Gossipsub, GossipType, GossipHandlers} from "./gossip";
import {MetadataController} from "./metadata";
import {getActiveForks, getCurrentAndNextFork, FORK_EPOCH_LOOKAHEAD} from "./forks";
import {IPeerMetadataStore, Libp2pPeerMetadataStore} from "./peers/metastore";
import {PeerManager} from "./peers/peerManager";
import {IPeerRpcScoreStore, PeerRpcScoreStore} from "./peers";
import {INetworkEventBus, NetworkEventBus} from "./events";
import {AttnetsService, SyncnetsService, CommitteeSubscription} from "./subnets";

interface INetworkModules {
  config: IBeaconConfig;
  libp2p: LibP2p;
  logger: ILogger;
  metrics: IMetrics | null;
  chain: IBeaconChain;
  db: IBeaconDb;
  reqRespHandlers: ReqRespHandlers;
  gossipHandlers: GossipHandlers;
  signal: AbortSignal;
}

export class Network implements INetwork {
  events: INetworkEventBus;
  reqResp: IReqResp;
  attnetsService: AttnetsService;
  syncnetsService: SyncnetsService;
  gossip: Eth2Gossipsub;
  metadata: MetadataController;
  peerMetadata: IPeerMetadataStore;
  peerRpcScores: IPeerRpcScoreStore;

  private readonly peerManager: PeerManager;
  private readonly libp2p: LibP2p;
  private readonly logger: ILogger;
  private readonly config: IBeaconConfig;
  private readonly clock: IBeaconClock;
  private readonly chain: IBeaconChain;

  private subscribedForks = new Set<ForkName>();

  constructor(private readonly opts: INetworkOptions & IReqRespOptions, modules: INetworkModules) {
    const {config, libp2p, logger, metrics, chain, reqRespHandlers, gossipHandlers, signal} = modules;
    this.libp2p = libp2p;
    this.logger = logger;
    this.config = config;
    this.clock = chain.clock;
    this.chain = chain;
    const networkEventBus = new NetworkEventBus();
    const metadata = new MetadataController({}, {config, chain, logger});
    const peerMetadata = new Libp2pPeerMetadataStore(libp2p.peerStore.metadataBook);
    const peerRpcScores = new PeerRpcScoreStore(peerMetadata);
    this.events = networkEventBus;
    this.metadata = metadata;
    this.peerRpcScores = peerRpcScores;
    this.peerMetadata = peerMetadata;
    this.reqResp = new ReqResp(
      {
        config,
        libp2p,
        forkDigestContext: chain.forkDigestContext,
        reqRespHandlers,
        peerMetadata,
        metadata,
        peerRpcScores,
        logger,
        networkEventBus,
        metrics,
      },
      opts
    );

    this.gossip = new Eth2Gossipsub({
      config,
      libp2p,
      logger,
      metrics,
      signal,
      gossipHandlers,
      forkDigestContext: chain.forkDigestContext,
    });

    this.attnetsService = new AttnetsService(config, chain, this.gossip, metadata, logger, opts);
    this.syncnetsService = new SyncnetsService(config, chain, this.gossip, metadata, logger, opts);

    this.peerManager = new PeerManager(
      {
        libp2p,
        reqResp: this.reqResp,
        attnetsService: this.attnetsService,
        syncnetsService: this.syncnetsService,
        logger,
        metrics,
        chain,
        config,
        peerMetadata,
        peerRpcScores,
        networkEventBus,
      },
      opts
    );

    this.chain.emitter.on(ChainEvent.clockEpoch, this.onEpoch);
    modules.signal.addEventListener("abort", () => this.close(), {once: true});
  }

  /** Destroy this instance. Can only be called once. */
  close(): void {
    this.chain.emitter.off(ChainEvent.clockEpoch, this.onEpoch);
  }

  async start(): Promise<void> {
    await this.libp2p.start();
    this.reqResp.start();
    this.metadata.start(this.getEnr(), this.config.getForkName(this.clock.currentSlot));
    this.peerManager.start();
    this.gossip.start();
    this.attnetsService.start();
    this.syncnetsService.start();
    const multiaddresses = this.libp2p.multiaddrs.map((m) => m.toString()).join(",");
    this.logger.info(`PeerId ${this.libp2p.peerId.toB58String()}, Multiaddrs ${multiaddresses}`);
  }

  async stop(): Promise<void> {
    // Must goodbye and disconnect before stopping libp2p
    await this.peerManager.goodbyeAndDisconnectAllPeers();
    this.peerManager.stop();
    this.metadata.stop();
    this.gossip.stop();
    this.reqResp.stop();
    this.attnetsService.stop();
    this.syncnetsService.stop();
    this.gossip.stop();
    await this.libp2p.stop();
  }

  get localMultiaddrs(): Multiaddr[] {
    return this.libp2p.multiaddrs;
  }

  get peerId(): PeerId {
    return this.libp2p.peerId;
  }

  getEnr(): ENR | undefined {
    const discv5Discovery = this.libp2p._discovery.get("discv5") as Discv5Discovery;
    return discv5Discovery?.discv5?.enr ?? undefined;
  }

  getConnectionsByPeer(): Map<string, Connection[]> {
    return this.libp2p.connectionManager.connections;
  }

  getConnectedPeers(): PeerId[] {
    return this.peerManager.getConnectedPeerIds();
  }

  hasSomeConnectedPeer(): boolean {
    return this.peerManager.hasSomeConnectedPeer();
  }

  /**
   * Request att subnets up `toSlot`. Network will ensure to mantain some peers for each
   */
  prepareBeaconCommitteeSubnet(subscriptions: CommitteeSubscription[]): void {
    this.attnetsService.addCommitteeSubscriptions(subscriptions);
    if (subscriptions.length > 0) this.peerManager.onCommitteeSubscriptions();
  }

  prepareSyncCommitteeSubnets(subscriptions: CommitteeSubscription[]): void {
    this.syncnetsService.addCommitteeSubscriptions(subscriptions);
    if (subscriptions.length > 0) this.peerManager.onCommitteeSubscriptions();
  }

  /**
   * The app layer needs to refresh the status of some peers. The sync have reached a target
   */
  reStatusPeers(peers: PeerId[]): void {
    this.peerManager.reStatusPeers(peers);
  }

  /**
   * Subscribe to all gossip events. Safe to call multiple times
   */
  subscribeGossipCoreTopics(): void {
    if (!this.isSubscribedToGossipCoreTopics()) {
      this.logger.info("Subscribed gossip core topics");
    }

    const currentEpoch = computeEpochAtSlot(this.chain.forkChoice.getHead().slot);
    for (const fork of getActiveForks(this.config, currentEpoch)) {
      this.subscribeCoreTopicsAtFork(fork);
    }
  }

  /**
   * Unsubscribe from all gossip events. Safe to call multiple times
   */
  unsubscribeGossipCoreTopics(): void {
    for (const fork of this.subscribedForks.values()) {
      this.unsubscribeCoreTopicsAtFork(fork);
    }
  }

  isSubscribedToGossipCoreTopics(): boolean {
    return this.subscribedForks.size > 0;
  }

  // Debug

  async connectToPeer(peer: PeerId, multiaddr: Multiaddr[]): Promise<void> {
    this.libp2p.peerStore.addressBook.add(peer, multiaddr);
    await this.libp2p.dial(peer);
  }

  async disconnectPeer(peer: PeerId): Promise<void> {
    await this.libp2p.hangUp(peer);
  }

  /**
   * Handle subscriptions through fork transitions, @see FORK_EPOCH_LOOKAHEAD
   */
  private onEpoch = (epoch: Epoch): void => {
    try {
      // Compute prev and next fork shifted, so next fork is still next at forkEpoch + FORK_EPOCH_LOOKAHEAD
      const forks = getCurrentAndNextFork(this.config, epoch - FORK_EPOCH_LOOKAHEAD - 1);

      // Only when a new fork is scheduled
      if (forks.nextFork) {
        const prevFork = forks.currentFork.name;
        const nextFork = forks.nextFork.name;
        const forkEpoch = forks.nextFork.epoch;

        // Before fork transition
        if (epoch === forkEpoch - FORK_EPOCH_LOOKAHEAD) {
          this.logger.info("Suscribing gossip topics to next fork", {nextFork});
          // Don't subscribe to new fork if the node is not subscribed to any topic
          if (this.isSubscribedToGossipCoreTopics()) this.subscribeCoreTopicsAtFork(nextFork);
          this.attnetsService.subscribeSubnetsToNextFork(nextFork);
          this.syncnetsService.subscribeSubnetsToNextFork(nextFork);
        }

        // After fork transition
        if (epoch === forkEpoch + FORK_EPOCH_LOOKAHEAD) {
          this.logger.info("Unsuscribing gossip topics from prev fork", {prevFork});
          this.unsubscribeCoreTopicsAtFork(prevFork);
          this.attnetsService.unsubscribeSubnetsFromPrevFork(prevFork);
          this.syncnetsService.unsubscribeSubnetsFromPrevFork(prevFork);
        }
      }
    } catch (e) {
      this.logger.error("Error on BeaconGossipHandler.onEpoch", {epoch}, e);
    }
  };

  private subscribeCoreTopicsAtFork = (fork: ForkName): void => {
    if (this.subscribedForks.has(fork)) return;
    this.subscribedForks.add(fork);

    this.gossip.subscribeTopic({type: GossipType.beacon_block, fork});
    this.gossip.subscribeTopic({type: GossipType.beacon_aggregate_and_proof, fork});
    this.gossip.subscribeTopic({type: GossipType.voluntary_exit, fork});
    this.gossip.subscribeTopic({type: GossipType.proposer_slashing, fork});
    this.gossip.subscribeTopic({type: GossipType.attester_slashing, fork});
    if (fork === ForkName.altair) {
      this.gossip.subscribeTopic({type: GossipType.sync_committee_contribution_and_proof, fork});
    }

    if (this.opts.subscribeAllSubnets) {
      for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
        this.gossip.subscribeTopic({type: GossipType.beacon_attestation, fork, subnet});
      }
      for (let subnet = 0; subnet < SYNC_COMMITTEE_SUBNET_COUNT; subnet++) {
        this.gossip.subscribeTopic({type: GossipType.sync_committee, fork, subnet});
      }
    }
  };

  private unsubscribeCoreTopicsAtFork = (fork: ForkName): void => {
    if (!this.subscribedForks.has(fork)) return;
    this.subscribedForks.delete(fork);

    this.gossip.unsubscribeTopic({type: GossipType.beacon_block, fork});
    this.gossip.unsubscribeTopic({type: GossipType.beacon_aggregate_and_proof, fork});
    this.gossip.unsubscribeTopic({type: GossipType.voluntary_exit, fork});
    this.gossip.unsubscribeTopic({type: GossipType.proposer_slashing, fork});
    this.gossip.unsubscribeTopic({type: GossipType.attester_slashing, fork});
    if (fork === ForkName.altair) {
      this.gossip.unsubscribeTopic({type: GossipType.sync_committee_contribution_and_proof, fork});
    }

    if (this.opts.subscribeAllSubnets) {
      for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
        this.gossip.unsubscribeTopic({type: GossipType.beacon_attestation, fork, subnet});
      }
      for (let subnet = 0; subnet < SYNC_COMMITTEE_SUBNET_COUNT; subnet++) {
        this.gossip.unsubscribeTopic({type: GossipType.sync_committee, fork, subnet});
      }
    }
  };
}
