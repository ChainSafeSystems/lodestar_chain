import {ERR_TOPIC_VALIDATOR_IGNORE, ERR_TOPIC_VALIDATOR_REJECT} from "libp2p-gossipsub/src/constants";
import {ATTESTATION_SUBNET_COUNT, phase0} from "@chainsafe/lodestar-types";
import {toHexString} from "@chainsafe/ssz";

import {IAttestationJob, IBlockJob} from "../../chain";
import {
  validateGossipAggregateAndProof,
  validateGossipAttestation,
  validateGossipBlock,
  validateGossipProposerSlashing,
  validateGossipVoluntaryExit,
  validateGossipAttesterSlashing,
} from "../../chain/validation";
import {
  BlockError,
  BlockErrorCode,
  AttestationError,
  AttestationErrorCode,
  AttesterSlashingError,
  AttesterSlashingErrorCode,
  ProposerSlashingError,
  ProposerSlashingErrorCode,
  VoluntaryExitError,
  VoluntaryExitErrorCode,
} from "../../chain/errors";

import {
  GossipType,
  IGossipMessage,
  TopicValidatorFn,
  ObjectValidatorFn,
  IObjectValidatorModules,
  GossipTopic,
  IBeaconAttestationTopic,
} from "./interface";
import {getGossipTopicString} from "./topic";
import {GossipValidationError} from "./errors";
import {DEFAULT_ENCODING} from "./constants";

// Gossip validation functions are wrappers around chain-level validation functions
// With a few additional elements:
//
// - Gossip error handling - chain-level validation throws eg: `BlockErrorCode` with many possible error types.
//   Gossip validation functions instead throw either "ignore" or "reject" errors.
//
// - Logging - chain-level validation has no logging.
//   For gossip, its useful to know, via logs/metrics, when gossip is received/ignored/rejected.
//
// - Gossip type conversion - Gossip validation functions operate on messages of binary data.
//   This data must be deserialized into the proper type, determined by the topic (fork digest)
//   This deserialization must have happened prior to the topic validator running.

export async function validateBeaconBlock(
  {chain, db, config, logger}: IObjectValidatorModules,
  _topic: GossipTopic,
  signedBlock: phase0.SignedBeaconBlock
): Promise<void> {
  const logContext = {
    blockRoot: toHexString(config.types.phase0.BeaconBlock.hashTreeRoot(signedBlock.message)),
    blockSlot: signedBlock.message.slot,
  };
  try {
    const blockJob: IBlockJob = {
      signedBlock,
      reprocess: false,
      prefinalized: false,
      validSignatures: false,
      validProposerSignature: false,
    };

    logger.verbose("Started gossip block validation", logContext);
    await validateGossipBlock(config, chain, db, blockJob);
    logger.verbose("Received valid gossip block", logContext);
  } catch (e: unknown) {
    if (!(e instanceof BlockError)) {
      logger.error("Gossip block validation threw a non-BlockError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }

    switch (e.type.code) {
      case BlockErrorCode.PROPOSAL_SIGNATURE_INVALID:
      case BlockErrorCode.INCORRECT_PROPOSER:
      case BlockErrorCode.KNOWN_BAD_BLOCK:
        logger.warn("Rejecting gossip block", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case BlockErrorCode.FUTURE_SLOT:
      case BlockErrorCode.PARENT_UNKNOWN:
        chain.receiveBlock(signedBlock);
        logger.warn("Ignoring gossip block", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);

      case BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT:
      case BlockErrorCode.REPEAT_PROPOSAL:
      default:
        logger.warn("Ignoring gossip block", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  }
}

export async function validateAggregatedAttestation(
  {chain, db, config, logger}: IObjectValidatorModules,
  _topic: GossipTopic,
  signedAggregateAndProof: phase0.SignedAggregateAndProof
): Promise<void> {
  const attestation = signedAggregateAndProof.message.aggregate;
  const logContext = {
    attestationSlot: attestation.data.slot,
    aggregatorIndex: signedAggregateAndProof.message.aggregatorIndex,
    aggregateRoot: toHexString(config.types.phase0.AggregateAndProof.hashTreeRoot(signedAggregateAndProof.message)),
    attestationRoot: toHexString(config.types.phase0.Attestation.hashTreeRoot(attestation)),
    targetEpoch: attestation.data.target.epoch,
  };

  try {
    const attestationJob = {
      attestation: attestation,
      validSignature: false,
    } as IAttestationJob;

    logger.verbose("Started gossip aggregate and proof validation", logContext);
    await validateGossipAggregateAndProof(config, chain, db, signedAggregateAndProof, attestationJob);
    logger.verbose("Received valid gossip aggregate and proof", logContext);
  } catch (e: unknown) {
    if (!(e instanceof AttestationError)) {
      logger.error("Gossip aggregate and proof validation threw a non-AttestationError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }

    switch (e.type.code) {
      case AttestationErrorCode.WRONG_NUMBER_OF_AGGREGATION_BITS:
      case AttestationErrorCode.KNOWN_BAD_BLOCK:
      case AttestationErrorCode.AGGREGATOR_NOT_IN_COMMITTEE:
      case AttestationErrorCode.INVALID_SELECTION_PROOF:
      case AttestationErrorCode.INVALID_SIGNATURE:
      case AttestationErrorCode.INVALID_AGGREGATOR:
        logger.warn("Rejecting gossip aggregate and proof", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case AttestationErrorCode.FUTURE_SLOT:
        chain.receiveAttestation(attestation);
        logger.warn("Ignoring gossip aggregate and proof", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);

      case AttestationErrorCode.PAST_SLOT:
      case AttestationErrorCode.AGGREGATE_ALREADY_KNOWN:
      case AttestationErrorCode.MISSING_ATTESTATION_PRESTATE:
      default:
        logger.warn("Ignoring gossip aggregate and proof", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  } finally {
    db.seenAttestationCache.addAggregateAndProof(signedAggregateAndProof.message);
  }
}

export async function validateCommitteeAttestation(
  {chain, db, config, logger}: IObjectValidatorModules,
  topic: IBeaconAttestationTopic,
  attestation: phase0.Attestation
): Promise<void> {
  const subnet = topic.subnet;

  const logContext = {
    attestationSlot: attestation.data.slot,
    attestationBlockRoot: toHexString(attestation.data.beaconBlockRoot),
    attestationRoot: toHexString(config.types.phase0.Attestation.hashTreeRoot(attestation)),
    subnet,
  };

  try {
    const attestationJob = {
      attestation,
      validSignature: false,
    } as IAttestationJob;

    logger.verbose("Started gossip committee attestation validation", logContext);
    await validateGossipAttestation(config, chain, db, attestationJob, subnet);
    logger.verbose("Received valid committee attestation", logContext);
  } catch (e: unknown) {
    if (!(e instanceof AttestationError)) {
      logger.error("Gossip attestation validation threw a non-AttestationError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
    switch (e.type.code) {
      case AttestationErrorCode.COMMITTEE_INDEX_OUT_OF_RANGE:
      case AttestationErrorCode.INVALID_SUBNET_ID:
      case AttestationErrorCode.BAD_TARGET_EPOCH:
      case AttestationErrorCode.NOT_EXACTLY_ONE_AGGREGATION_BIT_SET:
      case AttestationErrorCode.WRONG_NUMBER_OF_AGGREGATION_BITS:
      case AttestationErrorCode.INVALID_SIGNATURE:
      case AttestationErrorCode.KNOWN_BAD_BLOCK:
      case AttestationErrorCode.FINALIZED_CHECKPOINT_NOT_AN_ANCESTOR_OF_ROOT:
      case AttestationErrorCode.TARGET_BLOCK_NOT_AN_ANCESTOR_OF_LMD_BLOCK:
        logger.warn("Rejecting gossip attestation", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT:
      case AttestationErrorCode.MISSING_ATTESTATION_PRESTATE:
        // attestation might be valid after we receive block
        chain.receiveAttestation(attestation);
        logger.warn("Ignoring gossip attestation", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);

      case AttestationErrorCode.PAST_SLOT:
      case AttestationErrorCode.FUTURE_SLOT:
      case AttestationErrorCode.ATTESTATION_ALREADY_KNOWN:
      default:
        logger.warn("Ignoring gossip attestation", logContext, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  } finally {
    db.seenAttestationCache.addCommitteeAttestation(attestation);
  }
}

export async function validateVoluntaryExit(
  {chain, db, config, logger}: IObjectValidatorModules,
  _topic: GossipTopic,
  voluntaryExit: phase0.SignedVoluntaryExit
): Promise<void> {
  try {
    await validateGossipVoluntaryExit(config, chain, db, voluntaryExit);
  } catch (e: unknown) {
    if (!(e instanceof VoluntaryExitError)) {
      logger.error("Gossip voluntary exit validation threw a non-VoluntaryExitError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }

    switch (e.type.code) {
      case VoluntaryExitErrorCode.INVALID_EXIT:
        logger.warn("Rejecting gossip voluntary exit", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case VoluntaryExitErrorCode.EXIT_ALREADY_EXISTS:
      default:
        logger.warn("Ignoring gossip voluntary exit", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  }
}

export async function validateProposerSlashing(
  {chain, db, config, logger}: IObjectValidatorModules,
  _topic: GossipTopic,
  proposerSlashing: phase0.ProposerSlashing
): Promise<void> {
  try {
    await validateGossipProposerSlashing(config, chain, db, proposerSlashing);
  } catch (e: unknown) {
    if (!(e instanceof ProposerSlashingError)) {
      logger.error("Gossip proposer slashing validation threw a non-ProposerSlashingError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }

    switch (e.type.code) {
      case ProposerSlashingErrorCode.INVALID_SLASHING:
        logger.warn("Rejecting gossip proposer slashing", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case ProposerSlashingErrorCode.SLASHING_ALREADY_EXISTS:
      default:
        logger.warn("Ignoring gossip proposer slashing", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  }
}

export async function validateAttesterSlashing(
  {chain, db, config, logger}: IObjectValidatorModules,
  _topic: GossipTopic,
  attesterSlashing: phase0.AttesterSlashing
): Promise<void> {
  try {
    await validateGossipAttesterSlashing(config, chain, db, attesterSlashing);
  } catch (e: unknown) {
    if (!(e instanceof AttesterSlashingError)) {
      logger.error("Gossip attester slashing validation threw a non-AttesterSlashingError", e);
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }

    switch (e.type.code) {
      case AttesterSlashingErrorCode.INVALID_SLASHING:
        logger.warn("Rejecting gossip attester slashing", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);

      case AttesterSlashingErrorCode.SLASHING_ALREADY_EXISTS:
      default:
        logger.warn("Ignoring gossip attester slashing", {}, e);
        throw new GossipValidationError(ERR_TOPIC_VALIDATOR_IGNORE);
    }
  }
}

/**
 * Wrap an ObjectValidatorFn as a TopicValidatorFn
 *
 * See TopicValidatorFn here https://github.com/libp2p/js-libp2p-interfaces/blob/v0.5.2/src/pubsub/index.js#L529
 */
export function createTopicValidatorFn(
  modules: IObjectValidatorModules,
  objectValidatorFn: ObjectValidatorFn
): TopicValidatorFn {
  return async (topicString: string, msg: IGossipMessage): Promise<void> => {
    const gossipTopic = msg.gossipTopic;
    const gossipObject = msg.gossipObject;
    if (gossipTopic == null || gossipObject == null) {
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);
    }
    await objectValidatorFn(modules, gossipTopic, gossipObject);
  };
}

export function createTopicValidatorFnMap(modules: IObjectValidatorModules): Map<string, TopicValidatorFn> {
  const validatorFns = new Map<string, TopicValidatorFn>();
  const genesisValidatorsRoot = modules.chain.genesisValidatorsRoot;
  // TODO: other fork topics should get added here
  // phase0
  const fork = "phase0";
  const staticTopics: {
    type: GossipType;
    objectValidatorFn: ObjectValidatorFn;
  }[] = [
    {
      type: GossipType.beacon_block,
      objectValidatorFn: validateBeaconBlock as ObjectValidatorFn,
    },
    {
      type: GossipType.beacon_aggregate_and_proof,
      objectValidatorFn: validateAggregatedAttestation as ObjectValidatorFn,
    },
    {
      type: GossipType.voluntary_exit,
      objectValidatorFn: validateVoluntaryExit as ObjectValidatorFn,
    },
    {
      type: GossipType.proposer_slashing,
      objectValidatorFn: validateProposerSlashing as ObjectValidatorFn,
    },
    {
      type: GossipType.attester_slashing,
      objectValidatorFn: validateAttesterSlashing as ObjectValidatorFn,
    },
  ];
  for (const {type, objectValidatorFn} of staticTopics) {
    const topic = {type, fork, encoding: DEFAULT_ENCODING} as GossipTopic;
    const topicString = getGossipTopicString(modules.config, topic, genesisValidatorsRoot);
    const topicValidatorFn = createTopicValidatorFn(modules, objectValidatorFn);
    validatorFns.set(topicString, topicValidatorFn);
  }
  // create an entry for every committee subnet - phase0
  for (let subnet = 0; subnet < ATTESTATION_SUBNET_COUNT; subnet++) {
    const topic = {
      type: GossipType.beacon_attestation,
      fork,
      encoding: DEFAULT_ENCODING,
      subnet,
    } as GossipTopic;
    const topicString = getGossipTopicString(modules.config, topic, genesisValidatorsRoot);
    const topicValidatorFn = createTopicValidatorFn(modules, validateCommitteeAttestation as ObjectValidatorFn);
    validatorFns.set(topicString, topicValidatorFn);
  }
  return validatorFns;
}
