import {config} from "@chainsafe/lodestar-config/default";
import {createCachedBeaconState} from "@chainsafe/lodestar-beacon-state-transition";

import {ForkChoice} from "../../../../../src/chain";
import {LocalClock} from "../../../../../src/chain/clock";
import {generateInitialMaxBalances} from "../../../../utils/balances";
import {generateState} from "../../../../utils/state";
import {generateValidators} from "../../../../utils/validator";
import {setupApiImplTestServer} from "../../../../unit/api/impl/index.test";
import {BLSPubkey, ssz} from "@chainsafe/lodestar-types";
import {MAX_EFFECTIVE_BALANCE, FAR_FUTURE_EPOCH} from "@chainsafe/lodestar-params";
import {AttesterDuty} from "@chainsafe/lodestar-api/lib/routes/validator";
import {assembleAttesterDuty} from "../../../../../src/chain/factory/duties";
import {expect} from "chai";
import {itBench, setBenchOpts} from "@dapplion/benchmark";

const server = setupApiImplTestServer();
const chainStub = server.chainStub;
const syncStub = server.syncStub;
chainStub.clock = server.sandbox.createStubInstance(LocalClock);
chainStub.forkChoice = server.sandbox.createStubInstance(ForkChoice);
chainStub.getCanonicalBlockAtSlot.resolves(ssz.phase0.SignedBeaconBlock.defaultValue());
const dbStub = server.dbStub;

const numValidators = 200000;
const numAttachedValidators = 200;

const validators = generateValidators(numValidators, {
  effectiveBalance: MAX_EFFECTIVE_BALANCE,
  activationEpoch: 0,
  exitEpoch: FAR_FUTURE_EPOCH,
});
syncStub.isSynced.returns(true);
server.sandbox.stub(chainStub.clock, "currentEpoch").get(() => 0);
server.sandbox.stub(chainStub.clock, "currentSlot").get(() => 0);
dbStub.block.get.resolves({message: {stateRoot: Buffer.alloc(32)}} as any);
const _state = generateState(
  {
    slot: 0,
    validators,
    balances: generateInitialMaxBalances(config, numValidators),
  },
  config
);
const state = createCachedBeaconState(config, _state);
chainStub.getHeadStateAtCurrentEpoch.resolves(state);

const indices = Array.from({length: numAttachedValidators}, (_, i) => i * 5);

describe("getCommitteeAssignments vs assembleAttesterDuties performance test", async () => {
  setBenchOpts({
    maxMs: 10 * 1000,
    runs: 10,
  });

  // the new way of getting attester duties
  let newDuties: AttesterDuty[] = [];
  itBench("getCommitteeAssignments", () => {
    const validators = state.validators.persistent;
    const validatorData: BLSPubkey[] = [];
    indices.forEach((index) => {
      const validator = validators.get(index);
      if (!validator) {
        throw new Error(`Validator at index ${index} not in state`);
      }
      validatorData[index] = validator.pubkey;
    });
    newDuties = state.epochCtx.getCommitteeAssignments(0, validatorData);
  });

  itBench("new way (plus index2pubkey): getCommitteeAssignments", () => {
    const validatorData: BLSPubkey[] = [];
    indices.forEach((index) => {
      const pubkey = state.index2pubkey[index];
      if (!pubkey) {
        throw new Error(`Validator pubkey at validator index ${index} not found in state.`);
      }
      validatorData[index] = pubkey.toBytes();
    });
    newDuties = state.epochCtx.getCommitteeAssignments(0, validatorData);
  });

  // the old way of getting the attester duties
  let oldDuties: AttesterDuty[] = [];
  itBench("old way: assembleAttesterDuty batch", () => {
    oldDuties = [];
    for (const validatorIndex of indices) {
      const validator = state.validators[validatorIndex];
      const duty = assembleAttesterDuty(config, {pubkey: validator.pubkey, index: validatorIndex}, state.epochCtx, 0);
      if (duty) oldDuties.push(duty);
    }
  });

  // verify that both the old and new ways get the same data
  newDuties.sort((x, y) => x.validatorIndex - y.validatorIndex);
  oldDuties.sort((x, y) => x.validatorIndex - y.validatorIndex);
  expect(newDuties).to.deep.equal(oldDuties);
});