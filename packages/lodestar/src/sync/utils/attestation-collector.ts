import {ChainEvent, IBeaconChain} from "../../chain";
import {IBeaconDb} from "../../db";
import {IBeaconConfig, IForkName} from "@chainsafe/lodestar-config";
import {phase0, CommitteeIndex, Slot, ATTESTATION_SUBNET_COUNT} from "@chainsafe/lodestar-types";
import {INetwork} from "../../network";
import {computeSubnetForSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {ILogger} from "@chainsafe/lodestar-utils";
import {GossipHandlerFn, GossipType} from "../../network/gossip";

export interface IAttestationCollectorModules {
  chain: IBeaconChain;
  network: INetwork;
  db: IBeaconDb;
  logger: ILogger;
}

export class AttestationCollector {
  private readonly config: IBeaconConfig;
  private readonly chain: IBeaconChain;
  private readonly network: INetwork;
  private readonly db: IBeaconDb;
  private readonly logger: ILogger;
  private timers: NodeJS.Timeout[] = [];
  private aggregationDuties: Map<Slot, Set<CommitteeIndex>> = new Map();

  constructor(config: IBeaconConfig, modules: IAttestationCollectorModules) {
    this.config = config;
    this.chain = modules.chain;
    this.network = modules.network;
    this.db = modules.db;
    this.logger = modules.logger;
  }

  start(): void {
    this.chain.emitter.on(ChainEvent.clockSlot, this.checkDuties);
    for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
      this.network.gossip.handleTopic(
        {type: GossipType.beacon_attestation, fork: "phase0", subnet},
        this.handleCommitteeAttestation as GossipHandlerFn
      );
    }
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
      this.network.gossip.unhandleTopic(
        {type: GossipType.beacon_attestation, fork: "phase0", subnet},
        this.handleCommitteeAttestation as GossipHandlerFn
      );
    }
    this.chain.emitter.off(ChainEvent.clockSlot, this.checkDuties);
  }

  subscribeToCommitteeAttestations(slot: Slot, committeeIndex: CommitteeIndex): void {
    const fork = this.chain.getForkName();
    const headState = this.chain.getHeadState();
    const subnet = computeSubnetForSlot(this.config, headState, slot, committeeIndex);
    try {
      this.network.gossip.subscribeTopic({type: GossipType.beacon_attestation, fork, subnet});
      if (this.aggregationDuties.has(slot)) {
        this.aggregationDuties.get(slot)!.add(committeeIndex);
      } else {
        this.aggregationDuties.set(slot, new Set([committeeIndex]));
      }
    } catch (e: unknown) {
      this.logger.error("Unable to subscribe to attestation subnet", {subnet});
    }
  }

  private checkDuties = (slot: Slot): void => {
    const committees = this.aggregationDuties.get(slot) || new Set();
    const fork = this.chain.getForkName();
    const headState = this.chain.getHeadState();
    this.timers = [];
    for (const committeeIndex of committees) {
      const subnet = computeSubnetForSlot(this.config, headState, slot, committeeIndex);
      this.network.gossip.subscribeTopic({type: GossipType.beacon_attestation, fork, subnet});
      this.timers.push(
        setTimeout(() => {
          this.unsubscribeSubnet(subnet, fork);
        }, this.config.params.SECONDS_PER_SLOT * 1000)
      );
    }
    this.aggregationDuties.delete(slot);
  };

  private unsubscribeSubnet = (subnet: number, fork: IForkName): void => {
    try {
      this.network.gossip.unsubscribeTopic({type: GossipType.beacon_attestation, fork, subnet});
    } catch (e: unknown) {
      this.logger.error("Unable to unsubscribe to attestation subnet", {subnet});
    }
  };

  private handleCommitteeAttestation = async (attestation: phase0.Attestation): Promise<void> => {
    await this.db.attestation.add(attestation);
  };
}
