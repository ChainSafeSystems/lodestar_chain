import sinon from "sinon";
import {expect} from "chai";
import {config} from "@chainsafe/lodestar-config/mainnet";
import * as utils from "../../../../src/util";
import {processBlockHeader} from "../../../../src/phase0/naive/block";

import {generateState} from "../../../utils/state";
import {generateEmptyBlock} from "../../../utils/block";
import {generateValidator} from "../../../utils/validator";

/* eslint-disable no-empty */

describe("process block - block header", function () {
  const sandbox = sinon.createSandbox();

  let getBeaconProposeIndexStub: any;

  beforeEach(() => {
    getBeaconProposeIndexStub = sandbox.stub(utils, "getBeaconProposerIndex");
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("fail to process header - invalid slot", function () {
    const state = generateState({slot: 5});
    const block = generateEmptyBlock();
    block.slot = 4;
    try {
      processBlockHeader(config, state, block);
      expect.fail();
    } catch (e: unknown) {}
  });

  it("fail to process header - invalid parent header", function () {
    const state = generateState({slot: 5});
    const block = generateEmptyBlock();
    block.slot = 5;
    block.parentRoot = Buffer.alloc(10, 1);
    try {
      processBlockHeader(config, state, block);
      expect.fail();
    } catch (e: unknown) {}
  });

  it("fail to process header - proposerSlashed", function () {
    const state = generateState({slot: 5});
    state.validators.push(generateValidator({activation: 0, exit: 10, slashed: true}));
    const block = generateEmptyBlock();
    block.slot = 5;
    block.parentRoot = config.types.phase0.BeaconBlockHeader.hashTreeRoot(state.latestBlockHeader);
    try {
      processBlockHeader(config, state, block);
      expect.fail();
    } catch (e: unknown) {}
  });

  it.skip("should process block", function () {
    const state = generateState({slot: 5});
    state.validators.push(generateValidator({activation: 0, exit: 10}));
    const block = generateEmptyBlock();
    block.slot = 5;
    block.parentRoot = config.types.phase0.BeaconBlockHeader.hashTreeRoot(state.latestBlockHeader);
    getBeaconProposeIndexStub.returns(0);

    processBlockHeader(config, state, block);
  });
});
