import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ForkName, SYNC_COMMITTEE_SUBNET_COUNT} from "@chainsafe/lodestar-params";
import {Epoch, ssz} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {ChainEvent, IBeaconChain} from "../../chain";
import {getActiveForks} from "../forks";
import {Eth2Gossipsub, GossipType} from "../gossip";
import {MetadataController} from "../metadata";
import {SubnetMap} from "../peers/utils";
import {CommitteeSubscription, ISubnetsService, SubnetsServiceOpts} from "./interface";

const gossipType = GossipType.sync_committee;

/**
 * Manage sync committee subnets. Sync committees are long (~27h) so there aren't random long-lived subscriptions
 */
export class SyncnetsService implements ISubnetsService {
  /**
   * All currently subscribed subnets. Syncnets do not have additional long-lived
   * random subscriptions since the committees are already active for long periods of time.
   * Also, the node will aggregate through the entire period to simplify the validator logic.
   * So `subscriptionsCommittee` represents subnets to find peers and aggregate data.
   * This class will tell gossip to subscribe and un-subscribe.
   * If a value exists for `SubscriptionId` it means that gossip subscription is active in network.gossip
   */
  private subscriptionsCommittee = new SubnetMap();

  constructor(
    private readonly config: IBeaconConfig,
    private readonly chain: IBeaconChain,
    private readonly gossip: Eth2Gossipsub,
    private readonly metadata: MetadataController,
    private readonly logger: ILogger,
    private readonly opts?: SubnetsServiceOpts
  ) {}

  start(): void {
    this.chain.emitter.on(ChainEvent.clockEpoch, this.onEpoch);
  }

  stop(): void {
    this.chain.emitter.off(ChainEvent.clockEpoch, this.onEpoch);
  }

  /**
   * Get all active subnets for the hearbeat.
   */
  getActiveSubnets(): number[] {
    const currentSlot = this.chain.clock.currentSlot;
    return this.subscriptionsCommittee.getActive(currentSlot);
  }

  /**
   * Called from the API when validator is a part of a committee.
   */
  addCommitteeSubscriptions(subscriptions: CommitteeSubscription[]): void {
    // Trigger gossip subscription first, in batch
    if (subscriptions.length > 0) {
      this.subscribeToSubnets(subscriptions.map((sub) => sub.subnet));
    }

    // Then, register the subscriptions
    for (const {subnet, slot} of subscriptions) {
      this.subscriptionsCommittee.request({subnet, toSlot: slot});
    }

    // For syncnets regular subscriptions are persisted in the ENR
    this.updateMetadata();
  }

  /** Call ONLY ONCE: Two epoch before the fork, re-subscribe all existing random subscriptions to the new fork  */
  subscribeSubnetsToNextFork(nextFork: ForkName): void {
    if (nextFork === ForkName.altair) return;
    this.logger.info("Suscribing to random attnets to next fork", {nextFork});
    for (const subnet of this.subscriptionsCommittee.getAll()) {
      this.gossip.subscribeTopic({type: gossipType, fork: nextFork, subnet});
    }
  }

  /** Call  ONLY ONCE: Two epochs after the fork, un-subscribe all subnets from the old fork */
  unsubscribeSubnetsFromPrevFork(prevFork: ForkName): void {
    if (prevFork === ForkName.phase0) return;
    this.logger.info("Unsuscribing to random attnets from prev fork", {prevFork});
    for (let subnet = 0; subnet < SYNC_COMMITTEE_SUBNET_COUNT; subnet++) {
      if (!this.opts?.subscribeAllSubnets) {
        this.gossip.unsubscribeTopic({type: gossipType, fork: prevFork, subnet});
      }
    }
  }

  /**
   * Run per epoch, clean-up operations that are not urgent
   */
  private onEpoch = (epoch: Epoch): void => {
    try {
      const slot = computeStartSlotAtEpoch(epoch);
      // Unsubscribe to a committee subnet from subscriptionsCommittee.
      this.unsubscribeSubnets(this.subscriptionsCommittee.getExpired(slot));
    } catch (e) {
      this.logger.error("Error on SyncnetsService.onEpoch", {epoch}, e);
    }
  };

  /** Update ENR */
  private updateMetadata(): void {
    const subnets = ssz.altair.SyncSubnets.defaultValue();
    for (const subnet of this.subscriptionsCommittee.getAll()) {
      subnets[subnet] = true;
    }

    // Only update metadata if necessary, setting `metadata.[key]` triggers a write to disk
    if (!ssz.altair.SyncSubnets.equals(subnets, this.metadata.syncnets)) {
      this.metadata.syncnets = subnets;
    }
  }

  /** Tigger a gossip subcription only if not already subscribed */
  private subscribeToSubnets(subnets: number[]): void {
    const forks = getActiveForks(this.config, this.chain.clock.currentEpoch);
    for (const subnet of subnets) {
      if (!this.subscriptionsCommittee.has(subnet)) {
        for (const fork of forks) {
          this.gossip.subscribeTopic({type: gossipType, fork, subnet});
        }
      }
    }
  }

  /** Trigger a gossip un-subscrition only if no-one is still subscribed */
  private unsubscribeSubnets(subnets: number[]): void {
    const forks = getActiveForks(this.config, this.chain.clock.currentEpoch);
    for (const subnet of subnets) {
      // No need to check if active in subscriptionsCommittee since we only have a single SubnetMap
      for (const fork of forks) {
        if (!this.opts?.subscribeAllSubnets) {
          this.gossip.unsubscribeTopic({type: gossipType, fork, subnet});
        }
      }
    }
  }
}
