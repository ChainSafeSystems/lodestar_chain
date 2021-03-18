import {expect} from "chai";
import sinon, {SinonStubbedInstance} from "sinon";

import {config} from "@chainsafe/lodestar-config/minimal";
import {computeEpochAtSlot} from "@chainsafe/lodestar-beacon-state-transition";
import {ForkChoice} from "@chainsafe/lodestar-fork-choice";

import {validateAttestation} from "../../../../src/chain/attestation/validate";
import {LocalClock} from "../../../../src/chain/clock/LocalClock";
import {AttestationErrorCode} from "../../../../src/chain/errors";
import {generateAttestation} from "../../../utils/attestation";

describe("velidateAttestation", function () {
  let forkChoice: SinonStubbedInstance<ForkChoice>;
  let clock: SinonStubbedInstance<LocalClock>;

  beforeEach(function () {
    clock = sinon.createStubInstance(LocalClock);
    forkChoice = sinon.createStubInstance(ForkChoice);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("should throw on bad target epoch", function () {
    sinon.stub(clock, "currentSlot").get(() => 0);
    sinon.stub(clock, "currentEpoch").get(() => 0);
    // slot clearly not in target epoch
    const attestation = generateAttestation({data: {slot: 10000, target: {epoch: 0}}});
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.BAD_TARGET_EPOCH);
    }
  });

  it("should throw on past target epoch", function () {
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    const attestation = generateAttestation({data: {slot: 0, target: {epoch: 0}}});
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.PAST_EPOCH);
    }
  });

  it("should throw on future target epoch", function () {
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    const attestation = generateAttestation({data: {slot: 200, target: {epoch: computeEpochAtSlot(config, 200)}}});
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.FUTURE_EPOCH);
    }
  });

  it("should throw on future slot", function () {
    const attSlot = 101;
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    const attestation = generateAttestation({
      data: {slot: attSlot, target: {epoch: computeEpochAtSlot(config, attSlot)}},
    });
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.FUTURE_SLOT);
    }
  });

  it("should throw on unknown target", function () {
    const attSlot = 99;
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    forkChoice.hasBlock.returns(false);
    const attestation = generateAttestation({
      data: {slot: attSlot, target: {epoch: computeEpochAtSlot(config, attSlot)}},
    });
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.UNKNOWN_TARGET_ROOT);
    }
  });

  it("should throw on unknown head", function () {
    const attSlot = 99;
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    const targetRoot = Buffer.alloc(32);
    const headRoot = Buffer.alloc(32, 1);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    forkChoice.hasBlock.withArgs(targetRoot).returns(true);
    forkChoice.hasBlock.withArgs(headRoot).returns(false);
    const attestation = generateAttestation({
      data: {
        slot: attSlot,
        beaconBlockRoot: headRoot,
        target: {epoch: computeEpochAtSlot(config, attSlot), root: targetRoot},
      },
    });
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.UNKNOWN_BEACON_BLOCK_ROOT);
    }
  });

  it("should throw on head not descendant of target", function () {
    const attSlot = 99;
    const currentSlot = 100;
    const currentEpoch = computeEpochAtSlot(config, currentSlot);
    sinon.stub(clock, "currentSlot").get(() => currentSlot);
    sinon.stub(clock, "currentEpoch").get(() => currentEpoch);
    forkChoice.hasBlock.returns(true);
    forkChoice.isDescendant.returns(false);
    const attestation = generateAttestation({
      data: {
        slot: attSlot,
        target: {epoch: computeEpochAtSlot(config, attSlot)},
      },
    });
    try {
      validateAttestation({
        config,
        forkChoice,
        clock,
        job: {attestation, validSignature: false},
      });
      expect.fail("attestation should throw");
    } catch (e: unknown) {
      expect(e.type.code).to.equal(AttestationErrorCode.HEAD_NOT_TARGET_DESCENDANT);
    }
  });
});
