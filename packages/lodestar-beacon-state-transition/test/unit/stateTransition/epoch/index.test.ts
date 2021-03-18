import {expect} from "chai";
import sinon from "sinon";

import {config} from "@chainsafe/lodestar-config/mainnet";
import {GENESIS_SLOT} from "../../../../src/constants";
import {processEpoch} from "../../../../src/phase0/naive/epoch";
import * as justificationUtils from "../../../../src/phase0/naive/epoch/justification";
import * as balanceUpdateUtils from "../../../../src/phase0/naive/epoch/balanceUpdates";
import * as registryUpdateUtils from "../../../../src/phase0/naive/epoch/registryUpdates";
import * as slashingUtils from "../../../../src/phase0/naive/epoch/slashings";
import {generateState} from "../../../utils/state";

/* eslint-disable no-empty */

describe("process epoch - crosslinks", function () {
  const sandbox = sinon.createSandbox();

  let processJustificationAndFinalizationStub: any,
    processRewardsAndPenaltiesStub: any,
    processRegistryUpdatesStub: any,
    processSlashingsStub: any;

  beforeEach(() => {
    processJustificationAndFinalizationStub = sandbox.stub(justificationUtils, "processJustificationAndFinalization");
    processRewardsAndPenaltiesStub = sandbox.stub(balanceUpdateUtils, "processRewardsAndPenalties");
    processRegistryUpdatesStub = sandbox.stub(registryUpdateUtils, "processRegistryUpdates");
    processSlashingsStub = sandbox.stub(slashingUtils, "processSlashings");
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("should fail to process - genesis slot", function () {
    try {
      processEpoch(config, generateState({slot: GENESIS_SLOT}));
      expect.fail();
    } catch (e: unknown) {}
  });

  it("should fail to process - not epoch", function () {
    try {
      processEpoch(config, generateState({slot: 1}));
      expect.fail();
    } catch (e: unknown) {}
  });

  it("should process epoch", function () {
    processEpoch(config, generateState({slot: config.params.SLOTS_PER_EPOCH - 1}));
    expect(processJustificationAndFinalizationStub.calledOnce).to.be.true;
    expect(processRewardsAndPenaltiesStub.calledOnce).to.be.true;
    expect(processRegistryUpdatesStub.calledOnce).to.be.true;
    expect(processSlashingsStub.calledOnce).to.be.true;
  });
});
