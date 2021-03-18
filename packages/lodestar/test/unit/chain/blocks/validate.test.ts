import {expect} from "chai";
import sinon, {SinonStubbedInstance} from "sinon";

import {config} from "@chainsafe/lodestar-config/minimal";
import {ForkChoice} from "@chainsafe/lodestar-fork-choice";

import {validateBlock} from "../../../../src/chain/blocks/validate";
import {LocalClock} from "../../../../src/chain/clock";
import {BlockErrorCode} from "../../../../src/chain/errors";
import {getNewBlockJob} from "../../../utils/block";

describe("validateBlock", function () {
  let forkChoice: SinonStubbedInstance<ForkChoice>;
  let clock: SinonStubbedInstance<LocalClock>;

  beforeEach(function () {
    forkChoice = sinon.createStubInstance(ForkChoice);
    clock = sinon.createStubInstance(LocalClock);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("should throw on genesis block", function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    const job = getNewBlockJob(signedBlock);
    try {
      validateBlock({config, forkChoice, clock, job});
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.GENESIS_BLOCK);
    }
  });

  it("should throw on already known block", function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    signedBlock.message.slot = 1;
    const job = getNewBlockJob(signedBlock);
    forkChoice.hasBlock.returns(true);
    try {
      validateBlock({config, forkChoice, clock, job});
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.BLOCK_IS_ALREADY_KNOWN);
    }
  });

  it("should throw on already known block", function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    signedBlock.message.slot = 1;
    const job = getNewBlockJob(signedBlock);
    forkChoice.hasBlock.returns(false);
    forkChoice.getFinalizedCheckpoint.returns({epoch: 5, root: Buffer.alloc(32)});
    try {
      validateBlock({config, forkChoice, clock, job});
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.WOULD_REVERT_FINALIZED_SLOT);
    }
  });

  it("should throw on future slot", function () {
    const signedBlock = config.types.phase0.SignedBeaconBlock.defaultValue();
    signedBlock.message.slot = 1;
    const job = getNewBlockJob(signedBlock);
    forkChoice.hasBlock.returns(false);
    forkChoice.getFinalizedCheckpoint.returns({epoch: 0, root: Buffer.alloc(32)});
    sinon.stub(clock, "currentSlot").get(() => 0);
    try {
      validateBlock({config, forkChoice, clock, job});
      expect.fail("block should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(BlockErrorCode.FUTURE_SLOT);
    }
  });
});
