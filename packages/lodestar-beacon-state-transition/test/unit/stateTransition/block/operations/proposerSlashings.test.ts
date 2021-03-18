import {expect} from "chai";
import sinon from "sinon";
import {config} from "@chainsafe/lodestar-config/mainnet";
import {processProposerSlashing} from "../../../../../src/phase0/naive/block/operations";
import * as utils from "../../../../../src/util";
import * as validatorUtils from "../../../../../src/util/validator";
import {generateEmptyProposerSlashing} from "../../../../utils/slashings";
import {generateValidators} from "../../../../utils/validator";
import {generateState} from "../../../../utils/state";

/* eslint-disable no-empty */

describe("process block - proposer slashings", function () {
  const sandbox = sinon.createSandbox();

  let isSlashableValidatorStub: any, slashValidatorStub: any;

  beforeEach(() => {
    isSlashableValidatorStub = sandbox.stub(validatorUtils, "isSlashableValidator");
    slashValidatorStub = sandbox.stub(utils, "slashValidator");
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("should fail to process - different epoch", function () {
    const state = generateState({validators: generateValidators(0)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader2.message.slot = config.params.SLOTS_PER_EPOCH + 1;
    try {
      processProposerSlashing(config, state, proposerSlashing);
      expect.fail();
    } catch (e: unknown) {}
  });

  it("should fail to process - same headers", function () {
    const state = generateState({validators: generateValidators(0)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader2.message.slot = proposerSlashing.signedHeader1.message.slot;
    try {
      processProposerSlashing(config, state, proposerSlashing);
      expect.fail();
    } catch (e: unknown) {}
  });

  it("should fail to process - same headers", function () {
    const state = generateState({validators: generateValidators(0)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader2.message.slot = 2;
    isSlashableValidatorStub.returns(false);
    try {
      processProposerSlashing(config, state, proposerSlashing);
      expect.fail();
    } catch (e: unknown) {
      // different slot so it failed without calling isSlashableValidator
      expect(isSlashableValidatorStub.calledOnce).to.be.false;
    }
  });

  it("should fail to process - invalid signature 1", function () {
    const state = generateState({validators: generateValidators(0)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader2.message.slot = 1;
    isSlashableValidatorStub.returns(true);
    try {
      processProposerSlashing(config, state, proposerSlashing, true);
      expect.fail();
    } catch (e: unknown) {
      expect(isSlashableValidatorStub.calledOnce).to.be.true;
    }
  });

  it("should fail to process - invalid signature 2", function () {
    const state = generateState({validators: generateValidators(1)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader1.signature = Buffer.alloc(96, 1);
    proposerSlashing.signedHeader2.message.slot = 1;
    proposerSlashing.signedHeader2.signature = Buffer.alloc(96, 2);
    isSlashableValidatorStub.returns(true);
    try {
      processProposerSlashing(config, state, proposerSlashing);
      expect.fail();
    } catch (e: unknown) {
      expect(isSlashableValidatorStub.calledOnce).to.be.true;
    }
  });

  it.skip("should process", function () {
    const state = generateState({validators: generateValidators(1)});
    const proposerSlashing = generateEmptyProposerSlashing();
    proposerSlashing.signedHeader1.message.slot = 1;
    proposerSlashing.signedHeader2.message.slot = 1;
    isSlashableValidatorStub.returns(true);

    processProposerSlashing(config, state, proposerSlashing, false);
    expect(isSlashableValidatorStub.calledOnce).to.be.true;
    expect(slashValidatorStub.calledOnce).to.be.true;
  });
});
