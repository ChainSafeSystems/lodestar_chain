import crypto from "crypto";
import bls, {init} from "@chainsafe/bls";
import {BitList, List, TreeBacked} from "@chainsafe/ssz";
import {config} from "@chainsafe/lodestar-config/mainnet";
import {ValidatorIndex, BLSSignature, allForks} from "@chainsafe/lodestar-types";
import {ZERO_HASH, FAR_FUTURE_EPOCH} from "../../../../src/constants";
import {generateState} from "../../../utils/state";
import {generateValidators} from "../../../utils/validator";
import {expect} from "chai";
import {phase0, createCachedBeaconState, fast} from "../../../../src";

describe("signatureSets", () => {
  before("Init BLS", async () => {
    await init("blst-native");
  });

  it("should aggregate all signatures from a block", () => {
    const EMPTY_SIGNATURE = Buffer.alloc(96);

    const block: phase0.BeaconBlock = {
      slot: 0,
      proposerIndex: 0,
      parentRoot: crypto.randomBytes(32),
      stateRoot: ZERO_HASH,
      body: {
        randaoReveal: Buffer.alloc(96),
        eth1Data: {
          depositRoot: crypto.randomBytes(32),
          blockHash: crypto.randomBytes(32),
          depositCount: 0,
        },
        graffiti: crypto.randomBytes(32),
        proposerSlashings: [
          getMockProposerSlashings(
            {proposerIndex: 0, signature: EMPTY_SIGNATURE},
            {proposerIndex: 0, signature: EMPTY_SIGNATURE}
          ),
        ] as List<phase0.ProposerSlashing>,
        attesterSlashings: [
          getMockAttesterSlashings(
            {attestingIndices: [0] as List<ValidatorIndex>, signature: EMPTY_SIGNATURE},
            {attestingIndices: [0] as List<ValidatorIndex>, signature: EMPTY_SIGNATURE}
          ),
        ] as List<phase0.AttesterSlashing>,
        attestations: [
          getMockAttestations({attestingIndices: [0] as List<ValidatorIndex>, signature: EMPTY_SIGNATURE}),
        ] as List<phase0.Attestation>,
        deposits: ([] as phase0.Deposit[]) as List<phase0.Deposit>,
        voluntaryExits: [
          getMockSignedVoluntaryExit({validatorIndex: 0, signature: EMPTY_SIGNATURE}),
        ] as List<phase0.SignedVoluntaryExit>,
      },
    };

    const signedBlock: phase0.SignedBeaconBlock = {
      message: block,
      signature: EMPTY_SIGNATURE,
    };

    // Generate active validators
    const validators = generateValidators(32, {
      balance: config.params.MAX_EFFECTIVE_BALANCE,
      activation: 0,
      exit: FAR_FUTURE_EPOCH,
    });
    for (const validator of validators) {
      validator.pubkey = bls.SecretKey.fromKeygen().toPublicKey().toBytes();
    }

    const state = createCachedBeaconState(
      config,
      config.types.phase0.BeaconState.createTreeBackedFromStruct(
        generateState({validators})
      ) as TreeBacked<allForks.BeaconState>
    );

    const signatureSets = fast.getAllBlockSignatureSets(state, signedBlock);
    expect(signatureSets.length).to.equal(
      // block signature
      1 +
        // randao reveal
        1 +
        // 1 x 2 proposerSlashing signatures
        2 +
        // 1 x 2 attesterSlashings signatures
        2 +
        // 1 x attestations
        1 +
        // 1 x voluntaryExits
        1
    );
  });
});

interface IBlockProposerData {
  proposerIndex: ValidatorIndex;
  signature: BLSSignature;
}

function getMockProposerSlashings(data1: IBlockProposerData, data2: IBlockProposerData): phase0.ProposerSlashing {
  return {
    signedHeader1: getMockSignedBeaconBlockHeader(data1),
    signedHeader2: getMockSignedBeaconBlockHeader(data2),
  };
}

function getMockSignedBeaconBlockHeader(data: IBlockProposerData): phase0.SignedBeaconBlockHeader {
  return {
    message: {
      slot: 0,
      proposerIndex: data.proposerIndex,
      parentRoot: ZERO_HASH,
      stateRoot: ZERO_HASH,
      bodyRoot: ZERO_HASH,
    },
    signature: data.signature,
  };
}

interface IIndexAttestationData {
  attestingIndices: List<ValidatorIndex>;
  signature: BLSSignature;
}

function getMockAttesterSlashings(data1: IIndexAttestationData, data2: IIndexAttestationData): phase0.AttesterSlashing {
  return {
    attestation1: getMockIndexAttestation(data1),
    attestation2: getMockIndexAttestation(data2),
  };
}

function getMockIndexAttestation(data: IIndexAttestationData): phase0.IndexedAttestation {
  return {
    attestingIndices: data.attestingIndices,
    data: getAttestationData(),
    signature: data.signature,
  };
}

function getAttestationData(): phase0.AttestationData {
  return {
    slot: 0,
    index: 0,
    beaconBlockRoot: ZERO_HASH,
    source: {
      epoch: 0,
      root: ZERO_HASH,
    },
    target: {
      epoch: 0,
      root: ZERO_HASH,
    },
  };
}

function getMockAttestations(data: IIndexAttestationData): phase0.Attestation {
  return {
    aggregationBits: [true] as BitList,
    data: getAttestationData(),
    signature: data.signature,
  };
}

interface ISignedVoluntaryExitData {
  signature: BLSSignature;
  validatorIndex: ValidatorIndex;
}

function getMockSignedVoluntaryExit(data: ISignedVoluntaryExitData): phase0.SignedVoluntaryExit {
  return {
    message: {
      epoch: 0,
      validatorIndex: data.validatorIndex,
    },
    signature: data.signature,
  };
}
