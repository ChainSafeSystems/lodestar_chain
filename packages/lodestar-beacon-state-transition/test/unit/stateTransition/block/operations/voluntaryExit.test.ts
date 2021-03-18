import {expect} from "chai";
import sinon from "sinon";
import {config} from "@chainsafe/lodestar-config/mainnet";
import {FAR_FUTURE_EPOCH} from "../../../../../src/constants";
import * as utils from "../../../../../src/util";
import * as validatorUtils from "../../../../../src/util/validator";
import {processVoluntaryExit} from "../../../../../src/phase0/naive/block/operations";

import {generateValidator} from "../../../../utils/validator";
import {generateEmptySignedVoluntaryExit} from "../../../../utils/voluntaryExits";
import {generateState} from "../../../../utils/state";

describe("process block - voluntary exits", function () {
  const sandbox = sinon.createSandbox();

  let isActiveValidatorStub: any, initiateValidatorExitStub: any;

  beforeEach(() => {
    isActiveValidatorStub = sandbox.stub(validatorUtils, "isActiveValidator");
    initiateValidatorExitStub = sandbox.stub(utils, "initiateValidatorExit");
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("should fail - validator not active", function () {
    const state = generateState();
    const exit = generateEmptySignedVoluntaryExit();
    state.validators.push(generateValidator());
    isActiveValidatorStub.returns(false);
    try {
      processVoluntaryExit(config, state, exit);
      expect.fail();
    } catch (e: unknown) {
      expect(isActiveValidatorStub.calledOnce).to.be.true;
    }
  });

  it("should fail - already exited", function () {
    const state = generateState();
    const exit = generateEmptySignedVoluntaryExit();
    state.validators.push(generateValidator({activation: 0, exit: 1}));
    isActiveValidatorStub.returns(true);
    try {
      processVoluntaryExit(config, state, exit);
      expect.fail();
    } catch (e: unknown) {
      expect(isActiveValidatorStub.calledOnce).to.be.true;
    }
  });

  it("should fail - not valid", function () {
    const state = generateState({slot: 0});
    const exit = generateEmptySignedVoluntaryExit();
    exit.message.epoch = config.params.SLOTS_PER_EPOCH * 2;
    state.validators.push(generateValidator({activation: 0, exit: FAR_FUTURE_EPOCH}));
    isActiveValidatorStub.returns(true);
    try {
      processVoluntaryExit(config, state, exit);
      expect.fail();
    } catch (e: unknown) {
      expect(isActiveValidatorStub.calledOnce).to.be.true;
    }
  });

  it("should fail - validator not enough active", function () {
    const state = generateState({slot: config.params.SLOTS_PER_EPOCH * 2});
    const exit = generateEmptySignedVoluntaryExit();
    exit.message.epoch = 0;
    state.validators.push(generateValidator({activation: 0, exit: FAR_FUTURE_EPOCH}));
    isActiveValidatorStub.returns(true);
    try {
      processVoluntaryExit(config, state, exit);
      expect.fail();
    } catch (e: unknown) {
      expect(isActiveValidatorStub.calledOnce).to.be.true;
    }
  });

  it("should fail - invalid signature", function () {
    const state = generateState({slot: (config.params.SHARD_COMMITTEE_PERIOD + 1) * config.params.SLOTS_PER_EPOCH});
    const exit = generateEmptySignedVoluntaryExit();
    exit.message.epoch = 0;
    state.validators.push(generateValidator({activation: 0, exit: FAR_FUTURE_EPOCH}));
    isActiveValidatorStub.returns(true);
    try {
      processVoluntaryExit(config, state, exit);
      expect.fail();
    } catch (e: unknown) {
      expect(isActiveValidatorStub.calledOnce).to.be.true;
    }
  });

  it.skip("should process exit", function () {
    const validator = generateValidator({activation: 1, exit: FAR_FUTURE_EPOCH});
    const state = generateState({slot: (config.params.SHARD_COMMITTEE_PERIOD + 1) * config.params.SLOTS_PER_EPOCH});
    const exit = generateEmptySignedVoluntaryExit();
    exit.message.epoch = 0;
    state.validators.push(validator);
    isActiveValidatorStub.returns(true);

    processVoluntaryExit(config, state, exit, false);
    expect(isActiveValidatorStub.calledOnce).to.be.true;
    expect(initiateValidatorExitStub.calledOnce).to.be.true;
  });
});
