/**
 * @module api/rpc
 */

import bls, {Signature} from "@chainsafe/bls";
import {computeStartSlotAtEpoch, computeSubnetForCommitteesAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Bytes96, CommitteeIndex, Epoch, Root, phase0, Slot, ValidatorIndex} from "@chainsafe/lodestar-types";
import {assert, ILogger} from "@chainsafe/lodestar-utils";
import {readOnlyForEach} from "@chainsafe/ssz";
import {IAttestationJob, IBeaconChain} from "../../../chain";
import {assembleAttestationData} from "../../../chain/factory/attestation";
import {assembleBlock} from "../../../chain/factory/block";
import {assembleAttesterDuty} from "../../../chain/factory/duties";
import {validateGossipAggregateAndProof} from "../../../chain/validation";
import {IBeaconDb} from "../../../db";
import {IEth1ForBlockProduction} from "../../../eth1";
import {INetwork} from "../../../network";
import {IBeaconSync} from "../../../sync";
import {toGraffitiBuffer} from "../../../util/graffiti";
import {IApiOptions} from "../../options";
import {ApiError} from "../errors/api";
import {ApiNamespace, IApiModules} from "../interface";
import {checkSyncStatus} from "../utils";
import {BeaconCommitteeSubscription, IValidatorApi} from "./interface";

/**
 * Server implementation for handling validator duties.
 * See `@chainsafe/lodestar-validator/src/api` for the client implementation).
 */
export class ValidatorApi implements IValidatorApi {
  namespace: ApiNamespace;

  private config: IBeaconConfig;
  private chain: IBeaconChain;
  private db: IBeaconDb;
  private eth1: IEth1ForBlockProduction;
  private network: INetwork;
  private sync: IBeaconSync;
  private logger: ILogger;

  constructor(
    opts: Partial<IApiOptions>,
    modules: Pick<IApiModules, "config" | "chain" | "db" | "eth1" | "sync" | "network" | "logger">
  ) {
    this.namespace = ApiNamespace.VALIDATOR;
    this.config = modules.config;
    this.chain = modules.chain;
    this.db = modules.db;
    this.eth1 = modules.eth1;
    this.network = modules.network;
    this.sync = modules.sync;
    this.logger = modules.logger;
  }

  async produceBlock(slot: Slot, randaoReveal: Bytes96, graffiti = ""): Promise<phase0.BeaconBlock> {
    await checkSyncStatus(this.config, this.sync);
    return await assembleBlock(
      this.config,
      this.chain,
      this.db,
      this.eth1,
      slot,
      randaoReveal,
      toGraffitiBuffer(graffiti)
    );
  }

  async produceAttestationData(committeeIndex: CommitteeIndex, slot: Slot): Promise<phase0.AttestationData> {
    try {
      await checkSyncStatus(this.config, this.sync);
      const headRoot = this.chain.forkChoice.getHeadRoot();
      const state = await this.chain.regen.getBlockSlotState(headRoot, slot);
      return assembleAttestationData(state.config, state, headRoot, slot, committeeIndex);
    } catch (e: unknown) {
      this.logger.warn("Failed to produce attestation data", e);
      throw e;
    }
  }

  async getProposerDuties(epoch: Epoch): Promise<phase0.ProposerDuty[]> {
    await checkSyncStatus(this.config, this.sync);
    assert.gte(epoch, 0, "Epoch must be positive");
    assert.lte(epoch, this.chain.clock.currentEpoch, "Must get proposer duties in current epoch");
    const state = await this.chain.getHeadStateAtCurrentEpoch();
    const startSlot = computeStartSlotAtEpoch(this.config, epoch);
    const duties: phase0.ProposerDuty[] = [];

    for (let slot = startSlot; slot < startSlot + this.config.params.SLOTS_PER_EPOCH; slot++) {
      const blockProposerIndex = state.getBeaconProposer(slot);
      duties.push({slot, validatorIndex: blockProposerIndex, pubkey: state.validators[blockProposerIndex].pubkey});
    }
    return duties;
  }

  async getAttesterDuties(epoch: number, validatorIndices: ValidatorIndex[]): Promise<phase0.AttesterDuty[]> {
    await checkSyncStatus(this.config, this.sync);
    if (validatorIndices.length === 0) throw new ApiError(400, "No validator to get attester duties");
    if (epoch > this.chain.clock.currentEpoch + 1)
      throw new ApiError(400, "Cannot get duties for epoch more than one ahead");
    const state = await this.chain.getHeadStateAtCurrentEpoch();
    return validatorIndices
      .map((validatorIndex) => {
        const validator = state.validators[validatorIndex];
        if (!validator) {
          throw new ApiError(400, `Validator index ${validatorIndex} not in state`);
        }
        return assembleAttesterDuty(
          this.config,
          {pubkey: validator.pubkey, index: validatorIndex},
          state.epochCtx,
          epoch
        );
      })
      .filter((duty): duty is phase0.AttesterDuty => duty != null);
  }

  async getAggregatedAttestation(attestationDataRoot: Root, slot: Slot): Promise<phase0.Attestation> {
    await checkSyncStatus(this.config, this.sync);
    const attestations = await this.db.attestation.getAttestationsByDataRoot(slot, attestationDataRoot);

    if (attestations.length === 0) {
      throw Error("No matching attestations found for attestationData");
    }

    // first iterate through collected committee attestations
    // expanding each signature and building an aggregated bitlist
    const signatures: Signature[] = [];
    const aggregationBits = attestations[0].aggregationBits;
    for (const attestation of attestations) {
      try {
        const signature = bls.Signature.fromBytes(attestation.signature.valueOf() as Uint8Array);
        signatures.push(signature);
        readOnlyForEach(attestation.aggregationBits, (bit, index) => {
          if (bit) {
            aggregationBits[index] = true;
          }
        });
      } catch (e: unknown) {
        this.logger.verbose("Invalid attestation signature", e);
      }
    }

    // then create/return the aggregate signature
    return {
      data: attestations[0].data,
      signature: bls.Signature.aggregate(signatures).toBytes(),
      aggregationBits,
    };
  }

  async publishAggregateAndProofs(signedAggregateAndProofs: phase0.SignedAggregateAndProof[]): Promise<void> {
    await checkSyncStatus(this.config, this.sync);
    await Promise.all(
      signedAggregateAndProofs.map(async (signedAggregateAndProof) => {
        try {
          const attestation = signedAggregateAndProof.message.aggregate;
          const attestationJob = {
            attestation: attestation,
            validSignature: false,
          } as IAttestationJob;
          await validateGossipAggregateAndProof(
            this.config,
            this.chain,
            this.db,
            signedAggregateAndProof,
            attestationJob
          );
          await Promise.all([
            this.db.aggregateAndProof.add(signedAggregateAndProof.message),
            this.db.seenAttestationCache.addAggregateAndProof(signedAggregateAndProof.message),
            this.network.gossip.publishBeaconAggregateAndProof(signedAggregateAndProof),
          ]);
        } catch (e: unknown) {
          this.logger.warn("Failed to publish aggregate and proof", e);
        }
      })
    );
  }

  async prepareBeaconCommitteeSubnet(subscriptions: BeaconCommitteeSubscription[]): Promise<void> {
    await checkSyncStatus(this.config, this.sync);

    for (const {isAggregator, slot, committeeIndex, committeesAtSlot} of subscriptions) {
      if (isAggregator) {
        this.sync.collectAttestations(slot, committeeIndex);
      }
      const subnet = computeSubnetForCommitteesAtSlot(this.config, slot, committeesAtSlot, committeeIndex);
      await this.network.searchSubnetPeers([String(subnet)]);
    }
  }
}
