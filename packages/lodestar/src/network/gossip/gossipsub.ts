/* eslint-disable @typescript-eslint/naming-convention */
import Gossipsub from "libp2p-gossipsub";
import {InMessage} from "libp2p-interfaces/src/pubsub";
import Libp2p from "libp2p";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {ATTESTATION_SUBNET_COUNT, phase0, Root} from "@chainsafe/lodestar-types";
import {ILogger, toJson} from "@chainsafe/lodestar-utils";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";

import {IBeaconMetrics} from "../../metrics";
import {
  GossipEncoding,
  GossipHandlerFn,
  GossipObject,
  GossipTopic,
  GossipType,
  IGossipMessage,
  TopicValidatorFn,
} from "./interface";
import {msgIdToString, getMsgId, messageIsValid} from "./utils";
import {getGossipSSZDeserializer, getGossipSSZSerializer, getGossipTopic, getGossipTopicString} from "./topic";
import {encodeMessageData, decodeMessageData} from "./encoding";
import {DEFAULT_ENCODING} from "./constants";
import {GossipValidationError} from "./errors";
import {ERR_TOPIC_VALIDATOR_REJECT} from "libp2p-gossipsub/src/constants";

interface IGossipsubModules {
  config: IBeaconConfig;
  genesisValidatorsRoot: Root;
  libp2p: Libp2p;
  validatorFns: Map<string, TopicValidatorFn>;
  logger: ILogger;
  metrics?: IBeaconMetrics;
}

/**
 * Wrapper around js-libp2p-gossipsub with the following extensions:
 * - Eth2 message id
 * - Emits `GossipObject`, not `InMessage`
 * - Provides convenience interface:
 *   - `publishObject`
 *   - `subscribeTopic`
 *   - `unsubscribeTopic`
 *   - `handleTopic`
 *   - `unhandleTopic`
 *
 * See https://github.com/ethereum/eth2.0-specs/blob/dev/specs/phase0/p2p-interface.md#the-gossip-domain-gossipsub
 */
export class Eth2Gossipsub extends Gossipsub {
  private readonly config: IBeaconConfig;
  private readonly genesisValidatorsRoot: Root;
  private readonly logger: ILogger;
  private readonly metrics?: IBeaconMetrics;
  /**
   * Cached gossip objects
   *
   * Objects are deserialized during validation. If they pass validation, they get added here for later processing
   */
  private gossipObjects: Map<string, GossipObject>;
  /**
   * Cached gossip topic objects
   */
  private gossipTopics: Map<string, GossipTopic>;
  /**
   * Timeout for logging status message
   */
  private statusInterval?: NodeJS.Timeout;

  constructor({config, genesisValidatorsRoot, libp2p, validatorFns, logger, metrics}: IGossipsubModules) {
    // Gossipsub parameters defined here:
    // https://github.com/ethereum/eth2.0-specs/blob/dev/specs/phase0/p2p-interface.md#the-gossip-domain-gossipsub
    super(libp2p, {
      gossipIncoming: true,
      globalSignaturePolicy: "StrictNoSign" as const,
      D: 8,
      Dlo: 6,
      Dhi: 12,
      Dlazy: 6,
    });
    this.config = config;
    this.genesisValidatorsRoot = genesisValidatorsRoot;
    this.logger = logger;
    this.metrics = metrics;

    this.gossipObjects = new Map();
    this.gossipTopics = new Map();

    for (const [topic, validatorFn] of validatorFns.entries()) {
      this.topicValidators.set(topic, validatorFn);
    }
  }

  start(): void {
    super.start();
    this.statusInterval = setInterval(this.logSubscriptions, 12000);
  }

  stop(): void {
    try {
      super.stop();
      if (this.statusInterval) {
        clearInterval(this.statusInterval);
      }
    } catch (error) {
      if (error.code !== "ERR_HEARTBEAT_NO_RUNNING") {
        throw error;
      }
    }
  }

  /**
   * @override Use eth2 msg id and cache results to the msg
   */
  getMsgId(msg: IGossipMessage): Uint8Array {
    return getMsgId(msg);
  }

  /**
   * @override
   */
  async validate(message: IGossipMessage): Promise<void> {
    try {
      // message sanity check
      if (!messageIsValid(message)) {
        throw null;
      }
      // get GossipTopic and GossipObject, set on IGossipMessage
      const gossipTopic = this.getGossipTopic(message.topicIDs[0]);
      const gossipObject = getGossipSSZDeserializer(
        this.config,
        gossipTopic
      )(decodeMessageData(gossipTopic.encoding as GossipEncoding, message.data));
      // Lodestar ObjectValidatorFns rely on these properties being set
      message.gossipObject = gossipObject;
      message.gossipTopic = gossipTopic;
    } catch (e: unknown) {
      const err = new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);
      // must set gossip scores manually, since this usually happens in super.validate
      this.score.rejectMessage(message, err.code);
      this.gossipTracer.rejectMessage(message, err.code);
      throw e;
    }

    await super.validate(message); // No error here means that the incoming object is valid

    //`message.gossipObject` must have been set ^ so that we can cache the deserialized gossip object
    if (message.gossipObject) {
      this.gossipObjects.set(msgIdToString(this.getMsgId(message)), message.gossipObject);
    }
  }

  /**
   * @override
   * See https://github.com/libp2p/js-libp2p-interfaces/blob/v0.5.2/src/pubsub/index.js#L428
   *
   * Instead of emitting `InMessage`, emit `GossipObject`
   */
  _emitMessage(message: InMessage): void {
    const topic = message.topicIDs[0];
    const msgIdStr = msgIdToString(this.getMsgId(message));
    const gossipObject = this.gossipObjects.get(msgIdStr);
    if (gossipObject) {
      this.gossipObjects.delete(msgIdStr);
    }
    // Only messages that are currently subscribed and have properly been cached are emitted
    if (this.subscriptions.has(topic) && gossipObject) {
      this.emit(topic, gossipObject);
    }
  }

  /**
   * @override
   * Differs from upstream `unsubscribe` by _always_ unsubscribing,
   * instead of unsubsribing only when no handlers are attached to the topic
   *
   * See https://github.com/libp2p/js-libp2p-interfaces/blob/v0.8.3/src/pubsub/index.js#L720
   */
  unsubscribe(topic: string): void {
    if (!this.started) {
      throw new Error("Pubsub is not started");
    }

    if (this.subscriptions.has(topic)) {
      this.subscriptions.delete(topic);
      this.peers.forEach((_, id) => this._sendSubscriptions(id, [topic], false));
    }
  }

  /**
   * Publish a `GossipObject` on a `GossipTopic`
   */
  async publishObject(topic: GossipTopic, object: GossipObject): Promise<void> {
    this.logger.verbose("Publish to topic", toJson(topic));
    await this.publish(
      this.getGossipTopicString(topic),
      encodeMessageData(topic.encoding ?? DEFAULT_ENCODING, getGossipSSZSerializer(this.config, topic)(object))
    );
  }

  /**
   * Subscribe to a `GossipTopic`
   */
  subscribeTopic(topic: GossipTopic): void {
    this.logger.verbose("Subscribe to topic", toJson(topic));
    this.subscribe(this.getGossipTopicString(topic));
  }

  /**
   * Unsubscribe to a `GossipTopic`
   */
  unsubscribeTopic(topic: GossipTopic): void {
    this.logger.verbose("Unsubscribe to topic", toJson(topic));
    this.unsubscribe(this.getGossipTopicString(topic));
  }

  /**
   * Attach a handler to a `GossipTopic`
   */
  handleTopic(topic: GossipTopic, handler: GossipHandlerFn): void {
    this.on(this.getGossipTopicString(topic), handler);
  }

  /**
   * Remove a handler from a `GossipTopic`
   */
  unhandleTopic(topic: GossipTopic, handler: GossipHandlerFn): void {
    this.off(this.getGossipTopicString(topic), handler);
  }

  async publishBeaconBlock(signedBlock: phase0.SignedBeaconBlock): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.beacon_block,
        fork: this.config.getForkName(signedBlock.message.slot),
      },
      signedBlock
    );
  }

  async publishBeaconAggregateAndProof(aggregateAndProof: phase0.SignedAggregateAndProof): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.beacon_aggregate_and_proof,
        fork: this.config.getForkName(aggregateAndProof.message.aggregate.data.slot),
      },
      aggregateAndProof
    );
  }

  async publishBeaconAttestation(attestation: phase0.Attestation, subnet: number): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.beacon_attestation,
        fork: this.config.getForkName(attestation.data.slot),
        subnet,
      },
      attestation
    );
  }

  async publishVoluntaryExit(voluntaryExit: phase0.SignedVoluntaryExit): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.voluntary_exit,
        fork: this.config.getForkName(computeEpochAtSlot(this.config, voluntaryExit.message.epoch)),
      },
      voluntaryExit
    );
  }

  async publishProposerSlashing(proposerSlashing: phase0.ProposerSlashing): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.proposer_slashing,
        fork: this.config.getForkName(proposerSlashing.signedHeader1.message.slot),
      },
      proposerSlashing
    );
  }

  async publishAttesterSlashing(attesterSlashing: phase0.AttesterSlashing): Promise<void> {
    await this.publishObject(
      {
        type: GossipType.proposer_slashing,
        fork: this.config.getForkName(attesterSlashing.attestation1.data.slot),
      },
      attesterSlashing
    );
  }

  private getGossipTopicString(topic: GossipTopic): string {
    return getGossipTopicString(this.config, topic, this.genesisValidatorsRoot);
  }

  private getGossipTopic(topicString: string): GossipTopic {
    let topic = this.gossipTopics.get(topicString);
    if (topic == null) {
      topic = getGossipTopic(this.config, topicString, this.genesisValidatorsRoot);
      this.gossipTopics.set(topicString, topic);
    }
    return topic;
  }

  private logSubscriptions = (): void => {
    if (this.metrics) {
      // beacon attestation mesh gets counted separately so we can track mesh peers by subnet
      // zero out all gossip type & subnet choices, so the dashboard will register them
      for (const gossipType of Object.values(GossipType)) {
        this.metrics.gossipMeshPeersByType.set({gossipType}, 0);
      }
      for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
        this.metrics.gossipMeshPeersByBeaconAttestationSubnet.set({subnet}, 0);
      }
      // loop through all mesh entries, count each set size
      for (const [topicString, peers] of this.mesh.entries()) {
        const topic = this.getGossipTopic(topicString);
        if (topic.type === GossipType.beacon_attestation) {
          this.metrics.gossipMeshPeersByBeaconAttestationSubnet.set({subnet: topic.subnet}, peers.size);
        } else {
          this.metrics.gossipMeshPeersByType.set({gossipType: topic.type}, peers.size);
        }
      }
    }
    this.logger.info("Current gossip subscriptions", {
      subscriptions: Array.from(this.subscriptions),
    });
  };
}
