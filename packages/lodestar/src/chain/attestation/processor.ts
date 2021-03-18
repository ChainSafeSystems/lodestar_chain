import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {IForkChoice} from "@chainsafe/lodestar-fork-choice";

import {IAttestationJob} from "../interface";
import {IBeaconClock} from "../clock";
import {ChainEvent, ChainEventEmitter} from "../emitter";
import {IStateRegenerator} from "../regen";

import {processAttestation} from "./process";
import {validateAttestation} from "./validate";

type AttestationProcessorModules = {
  config: IBeaconConfig;
  emitter: ChainEventEmitter;
  forkChoice: IForkChoice;
  clock: IBeaconClock;
  regen: IStateRegenerator;
};

export class AttestationProcessor {
  private modules: AttestationProcessorModules;

  constructor(modules: AttestationProcessorModules) {
    this.modules = modules;
  }

  async processAttestationJob(job: IAttestationJob): Promise<void> {
    await processAttestationJob(this.modules, job);
  }
}

/**
 * Validate and process an attestation
 *
 * The only effects of running this are:
 * - forkChoice update, in the case of a valid attestation
 * - various events emitted: attestation, error:attestation
 * - (state cache update, from state regeneration)
 *
 * All other effects are provided by downstream event handlers
 */
export async function processAttestationJob(modules: AttestationProcessorModules, job: IAttestationJob): Promise<void> {
  try {
    validateAttestation({...modules, job});
    await processAttestation({...modules, job});
  } catch (e: unknown) {
    // above functions only throw AttestationError
    modules.emitter.emit(ChainEvent.errorAttestation, e);
  }
}
