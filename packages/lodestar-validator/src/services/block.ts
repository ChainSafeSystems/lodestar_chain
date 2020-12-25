/**
 * @module validator
 */

import {BeaconState, BLSPubkey, Epoch, Fork, Root, SignedBeaconBlock, Slot} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {SecretKey} from "@chainsafe/bls";
import {ILogger} from "@chainsafe/lodestar-utils";
import {toHexString} from "@chainsafe/ssz";
import {
  computeEpochAtSlot,
  computeSigningRoot,
  DomainType,
  getDomain,
} from "@chainsafe/lodestar-beacon-state-transition";
import {IApiClient} from "../api";
import {BeaconEventType} from "../api/interface/events";
import {ClockEventType} from "../api/interface/clock";
import {ISlashingProtection} from "../slashingProtection";

/**
 * Service that sets up and handles validator block proposal duties.
 */
export default class BlockProposingService {
  private readonly config: IBeaconConfig;
  private readonly provider: IApiClient;
  // validators private keys (order is important)
  private readonly secretKeys: SecretKey[] = [];
  // validators public keys (order is important)
  private readonly publicKeys: BLSPubkey[] = [];
  private readonly slashingProtection: ISlashingProtection;
  private readonly logger: ILogger;
  private readonly graffiti?: string;

  private nextProposals: Map<Slot, BLSPubkey> = new Map();

  public constructor(
    config: IBeaconConfig,
    secretKeys: SecretKey[],
    provider: IApiClient,
    slashingProtection: ISlashingProtection,
    logger: ILogger,
    graffiti?: string
  ) {
    this.config = config;
    for (const secretKey of secretKeys) {
      this.secretKeys.push(secretKey);
      this.publicKeys.push(secretKey.toPublicKey().toBytes());
    }
    this.provider = provider;
    this.slashingProtection = slashingProtection;
    this.logger = logger;
    this.graffiti = graffiti;
  }

  /**
   * Starts the BlockService by updating the validator block proposal duties and turning on the relevant listeners for clock events.
   */
  public start = async (): Promise<void> => {
    const currentEpoch = this.provider.clock.currentEpoch;
    // trigger getting duties for current epoch
    await this.updateDuties(currentEpoch);

    this.provider.on(ClockEventType.CLOCK_EPOCH, this.onClockEpoch);
    this.provider.on(ClockEventType.CLOCK_SLOT, this.onClockSlot);
    this.provider.on(BeaconEventType.HEAD, this.onHead);
  };

  /**
   * Stops the BlockService by turning off the relevant listeners for clock events.
   */
  public stop = async (): Promise<void> => {
    this.provider.off(ClockEventType.CLOCK_EPOCH, this.onClockEpoch);
    this.provider.off(ClockEventType.CLOCK_SLOT, this.onClockSlot);
    this.provider.off(BeaconEventType.HEAD, this.onHead);
  };

  /**
   * Update validator duties on each epoch.
   */
  public onClockEpoch = async ({epoch}: {epoch: Epoch}): Promise<void> => {
    await this.updateDuties(epoch);
  };

  /**
   * Create and publish a block if the validator is a proposer for a given clock slot.
   */
  public onClockSlot = async ({slot}: {slot: Slot}): Promise<void> => {
    const proposerPubKey = this.nextProposals.get(slot);
    if (proposerPubKey && slot !== 0) {
      this.nextProposals.delete(slot);
      this.logger.info("Validator is proposer!", {
        slot,
        validator: toHexString(proposerPubKey),
      });
      const fork = await this.provider.beacon.state.getFork("head");
      if (!fork) {
        return;
      }
      await this.createAndPublishBlock(
        this.getPubKeyIndex(proposerPubKey),
        slot,
        fork,
        this.provider.genesisValidatorsRoot
      );
    }
  };

  /**
   * Update list of block proposal duties on head upate.
   */
  public onHead = async ({slot, epochTransition}: {slot: Slot; epochTransition: boolean}): Promise<void> => {
    if (epochTransition) {
      // refetch this epoch's duties
      await this.updateDuties(computeEpochAtSlot(this.config, slot));
    }
  };

  /**
   * Fetch validator block proposal duties from the validator api and update local list of block duties accordingly.
   */
  public updateDuties = async (epoch: Epoch): Promise<void> => {
    this.logger.info("on new block epoch", {epoch, validator: toHexString(this.publicKeys[0])});
    const proposerDuties = await this.provider.validator.getProposerDuties(epoch, this.publicKeys).catch((e) => {
      this.logger.error("Failed to obtain proposer duties", e);
      return null;
    });
    if (!proposerDuties) {
      return;
    }
    for (const duty of proposerDuties) {
      if (!this.nextProposals.has(duty.slot) && this.getPubKeyIndex(duty.pubkey) !== -1) {
        this.logger.debug("Next proposer duty", {slot: duty.slot, validator: toHexString(duty.pubkey)});
        this.nextProposals.set(duty.slot, duty.pubkey);
      }
    }
  };

  /**
   * IFF a validator is selected, construct a block to propose.
   */
  public async createAndPublishBlock(
    proposerIndex: number,
    slot: Slot,
    fork: Fork,
    genesisValidatorsRoot: Root
  ): Promise<SignedBeaconBlock | null> {
    const epoch = computeEpochAtSlot(this.config, slot);
    const randaoDomain = getDomain(this.config, {fork, genesisValidatorsRoot} as BeaconState, DomainType.RANDAO, epoch);
    const randaoSigningRoot = computeSigningRoot(this.config, this.config.types.Epoch, epoch, randaoDomain);
    let block;
    try {
      block = await this.provider.validator.produceBlock(
        slot,
        this.secretKeys[proposerIndex].sign(randaoSigningRoot).toBytes(),
        this.graffiti || ""
      );
    } catch (e) {
      this.logger.error("Failed to produce block", {slot}, e);
    }
    if (!block) {
      return null;
    }
    const proposerDomain = getDomain(
      this.config,
      {fork, genesisValidatorsRoot} as BeaconState,
      DomainType.BEACON_PROPOSER,
      computeEpochAtSlot(this.config, slot)
    );
    const signingRoot = computeSigningRoot(this.config, this.config.types.BeaconBlock, block, proposerDomain);

    await this.slashingProtection.checkAndInsertBlockProposal(this.publicKeys[proposerIndex], {
      slot: block.slot,
      signingRoot,
    });

    const signedBlock: SignedBeaconBlock = {
      message: block,
      signature: this.secretKeys[proposerIndex].sign(signingRoot).toBytes(),
    };
    try {
      await this.provider.beacon.blocks.publishBlock(signedBlock);
      this.logger.info("Proposed block", {hash: toHexString(this.config.types.BeaconBlock.hashTreeRoot(block)), slot});
    } catch (e) {
      this.logger.error("Failed to publish block", {slot}, e);
    }
    return signedBlock;
  }

  public getRpcClient(): IApiClient {
    return this.provider;
  }

  private getPubKeyIndex(search: BLSPubkey): number {
    return this.publicKeys.findIndex((pubkey) => {
      return this.config.types.BLSPubkey.equals(pubkey, search);
    });
  }
}