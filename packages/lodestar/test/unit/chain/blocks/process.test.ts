import {expect} from "chai";
import sinon, {SinonStubbedInstance} from "sinon";

import {config} from "@chainsafe/lodestar-config/minimal";
import {ForkChoice} from "@chainsafe/lodestar-fork-choice";

import {ChainEventEmitter} from "../../../../src/chain";
import {BlockErrorCode} from "../../../../src/chain/errors";
import {CheckpointStateCache} from "../../../../src/chain/stateCache";
import {processBlock} from "../../../../src/chain/blocks/process";
import {RegenError, RegenErrorCode, StateRegenerator} from "../../../../src/chain/regen";
import {getNewBlockJob} from "../../../utils/block";

describe("processBlock", function () {
  const emitter = new ChainEventEmitter();
  let forkChoice: SinonStubbedInstance<ForkChoice>;
  let checkpointStateCache: SinonStubbedInstance<CheckpointStateCache>;
  let regen: SinonStubbedInstance<StateRegenerator>;

  beforeEach(function () {
    forkChoice = sinon.createStubInstance(ForkChoice);
    checkpointStateCache = sinon.createStubInstance(CheckpointStateCache);
    regen = sinon.createStubInstance(StateRegenerator);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("should throw on unknown parent", async function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    signedBlock.message.slot = 1;
    const job = getNewBlockJob(signedBlock);
    forkChoice.hasBlock.returns(false);
    try {
      await processBlock({
        forkChoice,
        checkpointStateCache: (checkpointStateCache as unknown) as CheckpointStateCache,
        regen,
        emitter,
        job,
      });
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.PARENT_UNKNOWN);
    }
  });

  it("should throw on missing prestate", async function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    signedBlock.message.slot = 1;
    const job = getNewBlockJob(signedBlock);
    forkChoice.hasBlock.returns(true);
    regen.getPreState.rejects(new RegenError({code: RegenErrorCode.STATE_TRANSITION_ERROR, error: new Error()}));
    try {
      await processBlock({
        forkChoice,
        checkpointStateCache: (checkpointStateCache as unknown) as CheckpointStateCache,
        regen,
        emitter,
        job,
      });
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.PRESTATE_MISSING);
    }
  });
});
