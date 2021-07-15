import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {
  ATTESTATION_SUBNET_COUNT,
  EPOCHS_PER_RANDOM_SUBNET_SUBSCRIPTION,
  ForkName,
  RANDOM_SUBNETS_PER_VALIDATOR,
  SLOTS_PER_EPOCH,
} from "@chainsafe/lodestar-params";
import {Epoch, Slot, ssz} from "@chainsafe/lodestar-types";
import {ILogger, randBetween} from "@chainsafe/lodestar-utils";
import {shuffle} from "../../util/shuffle";
import {ChainEvent, IBeaconChain} from "../../chain";
import {Eth2Gossipsub, GossipType} from "../gossip";
import {MetadataController} from "../metadata";
import {SubnetMap, RequestedSubnet} from "../peers/utils";
import {getActiveForks} from "../forks";
import {IAttnetsService, CommitteeSubscription, SubnetsServiceOpts} from "./interface";

/**
 * The time (in slots) before a last seen validator is considered absent and we unsubscribe from the random
 * gossip topics that we subscribed to due to the validator connection.
 */
const LAST_SEEN_VALIDATOR_TIMEOUT = 150;

const gossipType = GossipType.beacon_attestation;

/**
 * Manage random (long lived) subnets and committee (short lived) subnets.
 */
export class AttnetsService implements IAttnetsService {
  /** Committee subnets - PeerManager must find peers for those */
  private committeeSubnets = new SubnetMap();
  /**
   * All currently subscribed short-lived subnets, for attestation aggregation
   * This class will tell gossip to subscribe and un-subscribe
   * If a value exists for `SubscriptionId` it means that gossip subscription is active in network.gossip
   */
  private subscriptionsCommittee = new SubnetMap();
  /** Same as `subscriptionsCommittee` but for long-lived subnets. May overlap with `subscriptionsCommittee` */
  private subscriptionsRandom = new SubnetMap();

  /**
   * A collection of seen validators. These dictate how many random subnets we should be
   * subscribed to. As these time out, we unsubscribe from the required random subnets and update our ENR.
   * This is a map of validator index and its last active slot.
   */
  private knownValidators = new Map<number, Slot>();

  constructor(
    private readonly config: IChainForkConfig,
    private readonly chain: IBeaconChain,
    private readonly gossip: Eth2Gossipsub,
    private readonly metadata: MetadataController,
    private readonly logger: ILogger,
    private readonly opts?: SubnetsServiceOpts
  ) {}

  start(): void {
    this.chain.emitter.on(ChainEvent.clockSlot, this.onSlot);
    this.chain.emitter.on(ChainEvent.clockEpoch, this.onEpoch);
  }

  stop(): void {
    this.chain.emitter.off(ChainEvent.clockSlot, this.onSlot);
    this.chain.emitter.off(ChainEvent.clockEpoch, this.onEpoch);
  }

  /**
   * Get all active subnets for the hearbeat.
   */
  getActiveSubnets(): number[] {
    const currentSlot = this.chain.clock.currentSlot;
    // Omit subscriptionsRandom, not necessary to force the network component to keep peers on that subnets
    return this.committeeSubnets.getActive(currentSlot);
  }

  /**
   * Called from the API when validator is a part of a committee.
   */
  addCommitteeSubscriptions(subscriptions: CommitteeSubscription[]): void {
    const currentSlot = this.chain.clock.currentSlot;
    let addedknownValidators = false;
    const subnetsToSubscribe: RequestedSubnet[] = [];

    for (const {validatorIndex, subnet, slot, isAggregator} of subscriptions) {
      // Add known validator
      if (!this.knownValidators.has(validatorIndex)) addedknownValidators = true;
      this.knownValidators.set(validatorIndex, currentSlot);

      // the peer-manager heartbeat will help find the subnet
      this.committeeSubnets.request({subnet, toSlot: slot + 1});
      if (isAggregator) {
        // need exact slot here
        subnetsToSubscribe.push({subnet, toSlot: slot});
      }
    }

    // Trigger gossip subscription first, in batch
    if (subnetsToSubscribe.length > 0) {
      this.subscribeToSubnets(subnetsToSubscribe.map((sub) => sub.subnet));
    }
    // Then, register the subscriptions
    for (const subscription of subnetsToSubscribe) {
      this.subscriptionsCommittee.request(subscription);
    }

    if (addedknownValidators) this.rebalanceRandomSubnets();
  }

  /**
   * Check if a subscription is still active before handling a gossip object
   */
  shouldProcess(subnet: number, slot: Slot): boolean {
    return this.subscriptionsCommittee.isActiveAtSlot(subnet, slot);
  }

  /** Call ONLY ONCE: Two epoch before the fork, re-subscribe all existing random subscriptions to the new fork  */
  subscribeSubnetsToNextFork(nextFork: ForkName): void {
    this.logger.info("Suscribing to random attnets to next fork", {nextFork});
    for (const subnet of this.subscriptionsRandom.getAll()) {
      this.gossip.subscribeTopic({type: gossipType, fork: nextFork, subnet});
    }
  }

  /** Call  ONLY ONCE: Two epochs after the fork, un-subscribe all subnets from the old fork */
  unsubscribeSubnetsFromPrevFork(prevFork: ForkName): void {
    this.logger.info("Unsuscribing to random attnets from prev fork", {prevFork});
    for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
      if (!this.opts?.subscribeAllSubnets) {
        this.gossip.unsubscribeTopic({type: gossipType, fork: prevFork, subnet});
      }
    }
  }

  /**
   * Run per slot.
   */
  private onSlot = (slot: Slot): void => {
    try {
      this.unsubscribeExpiredCommitteeSubnets(slot);
    } catch (e) {
      this.logger.error("Error on AttnetsService.onSlot", {slot}, e);
    }
  };

  /**
   * Run per epoch, clean-up operations that are not urgent
   */
  private onEpoch = (epoch: Epoch): void => {
    try {
      const slot = computeStartSlotAtEpoch(epoch);
      this.unsubscribeExpiredRandomSubnets(slot);
      this.pruneExpiredKnownValidators(slot);
    } catch (e) {
      this.logger.error("Error on AttnetsService.onEpoch", {epoch}, e);
    }
  };

  /**
   * Unsubscribe to a committee subnet from subscribedCommitteeSubnets.
   * If a random subnet is present, we do not unsubscribe from it.
   */
  private unsubscribeExpiredCommitteeSubnets(slot: Slot): void {
    const expired = this.subscriptionsCommittee.getExpired(slot);
    this.unsubscribeSubnets(expired, slot);
  }

  /**
   * A random subnet has expired.
   * This function selects a new subnet to join, or extends the expiry if there are no more
   * available subnets to choose from.
   */
  private unsubscribeExpiredRandomSubnets(slot: Slot): void {
    const expired = this.subscriptionsRandom.getExpired(slot);
    // TODO: Optimization: If we have to be subcribed to all subnets, no need to unsubscribe. Just extend the timeout
    // Prune subnets and re-subcribe to new ones
    this.unsubscribeSubnets(expired, slot);
    this.rebalanceRandomSubnets();
  }

  /**
   * A known validator has not sent a subscription in a while. They are considered offline and the
   * beacon node no longer needs to be subscribed to the allocated random subnets.
   *
   * We don't keep track of a specific validator to random subnet, rather the ratio of active
   * validators to random subnets. So when a validator goes offline, we can simply remove the
   * allocated amount of random subnets.
   */
  private pruneExpiredKnownValidators(currentSlot: Slot): void {
    let deletedKnownValidators = false;
    for (const [index, slot] of this.knownValidators.entries()) {
      if (currentSlot > slot + LAST_SEEN_VALIDATOR_TIMEOUT) {
        const deleted = this.knownValidators.delete(index);
        if (deleted) deletedKnownValidators = true;
      }
    }

    if (deletedKnownValidators) this.rebalanceRandomSubnets();
  }

  /**
   * Called when we have new validators or expired validators.
   * knownValidators should be updated before this function.
   */
  private rebalanceRandomSubnets(): void {
    const slot = this.chain.clock.currentSlot;
    // By limiting to ATTESTATION_SUBNET_COUNT, if target is still over subnetDiff equals 0
    const targetRandomSubnetCount = Math.min(
      this.knownValidators.size * RANDOM_SUBNETS_PER_VALIDATOR,
      ATTESTATION_SUBNET_COUNT
    );
    const subnetDiff = targetRandomSubnetCount - this.subscriptionsRandom.size;

    // subscribe to more random subnets
    if (subnetDiff > 0) {
      const activeSubnets = new Set(this.subscriptionsRandom.getActive(slot));
      const allSubnets = Array.from({length: ATTESTATION_SUBNET_COUNT}, (_, i) => i);
      const availableSubnets = allSubnets.filter((subnet) => !activeSubnets.has(subnet));
      const subnetsToConnect = shuffle(availableSubnets).slice(0, subnetDiff);

      // Tell gossip to connect to the subnets if not connected already
      this.subscribeToSubnets(subnetsToConnect);

      // Register these new subnets until some future slot
      for (const subnet of subnetsToConnect) {
        // the heartbeat will help connect to respective peers
        this.subscriptionsRandom.request({subnet, toSlot: randomSubscriptionSlotLen() + slot});
      }
    }

    // unsubscribe some random subnets
    if (subnetDiff < 0) {
      const activeRandomSubnets = this.subscriptionsRandom.getActive(slot);
      // TODO: Do we want to remove the oldest subnets or the newest subnets?
      // .slice(-2) will extract the last two items of the array
      const toRemoveSubnets = activeRandomSubnets.slice(subnetDiff);
      for (const subnet of toRemoveSubnets) {
        this.subscriptionsRandom.delete(subnet);
      }
      this.unsubscribeSubnets(toRemoveSubnets, slot);
    }

    // If there has been a change update the local ENR bitfield
    if (subnetDiff !== 0) {
      this.updateMetadata();
    }
  }

  /** Update ENR */
  private updateMetadata(): void {
    const subnets = ssz.phase0.AttestationSubnets.defaultValue();
    for (const subnet of this.subscriptionsRandom.getAll()) {
      subnets[subnet] = true;
    }

    // Only update metadata if necessary, setting `metadata.[key]` triggers a write to disk
    if (!ssz.phase0.AttestationSubnets.equals(subnets, this.metadata.attnets)) {
      this.metadata.attnets = subnets;
    }
  }

  /** Tigger a gossip subcription only if not already subscribed */
  private subscribeToSubnets(subnets: number[]): void {
    const forks = getActiveForks(this.config, this.chain.clock.currentEpoch);
    for (const subnet of subnets) {
      if (!this.subscriptionsCommittee.has(subnet) && !this.subscriptionsRandom.has(subnet)) {
        for (const fork of forks) {
          this.gossip.subscribeTopic({type: gossipType, fork, subnet});
        }
      }
    }
  }

  /** Trigger a gossip un-subscrition only if no-one is still subscribed */
  private unsubscribeSubnets(subnets: number[], slot: Slot): void {
    if (this.opts?.subscribeAllSubnets) return;

    const forks = getActiveForks(this.config, this.chain.clock.currentEpoch);
    for (const subnet of subnets) {
      if (
        !this.subscriptionsCommittee.isActiveAtSlot(subnet, slot) &&
        !this.subscriptionsRandom.isActiveAtSlot(subnet, slot)
      ) {
        for (const fork of forks) {
          if (!this.opts?.subscribeAllSubnets) {
            this.gossip.unsubscribeTopic({type: gossipType, fork, subnet});
          }
        }
      }
    }
  }
}

function randomSubscriptionSlotLen(): Slot {
  return (
    randBetween(EPOCHS_PER_RANDOM_SUBNET_SUBSCRIPTION, 2 * EPOCHS_PER_RANDOM_SUBNET_SUBSCRIPTION) * SLOTS_PER_EPOCH
  );
}
