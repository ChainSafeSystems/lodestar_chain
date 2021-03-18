import {config} from "@chainsafe/lodestar-config/mainnet";
import {Gwei, phase0} from "@chainsafe/lodestar-types";
import {init} from "@chainsafe/bls";
import {interopSecretKeys} from "@chainsafe/lodestar-utils";
import {fromHexString, List, TreeBacked} from "@chainsafe/ssz";
import {getBeaconProposerIndex} from "../../src/util/proposer";
import {profilerLogger} from "../utils/logger";

let archivedState: TreeBacked<phase0.BeaconState> | null = null;
let signedBlock: TreeBacked<phase0.SignedBeaconBlock> | null = null;
const logger = profilerLogger();

/**
 * This is generated from Medalla state 756416
 */
export async function generatePerformanceState(): Promise<TreeBacked<phase0.BeaconState>> {
  if (!archivedState) {
    const state = config.types.phase0.BeaconState.defaultValue();
    state.genesisTime = 1596546008;
    state.genesisValidatorsRoot = fromHexString("0x04700007fabc8282644aed6d1c7c9e21d38a03a0c4ba193f3afe428824b3a673");
    state.slot = 756416;
    state.fork = {
      currentVersion: fromHexString("0x00000001"),
      previousVersion: fromHexString("0x00000001"),
      epoch: 0,
    };
    state.latestBlockHeader = {
      slot: 756415,
      proposerIndex: 80882,
      parentRoot: fromHexString("0x5b83c3078e474b86af60043eda82a34c3c2e5ebf83146b14d9d909aea4163ef2"),
      stateRoot: fromHexString("0x2761ae355e8a53c11e0e37d5e417f8984db0c53fa83f1bc65f89c6af35a196a7"),
      bodyRoot: fromHexString("0x249a1962eef90e122fa2447040bfac102798b1dba9c73e5593bc5aa32eb92bfd"),
    };
    state.blockRoots = Array.from({length: config.params.SLOTS_PER_HISTORICAL_ROOT}, (_, i) => Buffer.alloc(32, i));
    state.stateRoots = Array.from({length: config.params.SLOTS_PER_HISTORICAL_ROOT}, (_, i) => Buffer.alloc(32, i));
    // historicalRoots
    state.eth1Data = {
      depositCount: 114038,
      depositRoot: fromHexString("0xcb1f89a924cfd31224823db5a41b1643f10faa7aedf231f1e28887f6ee98c047"),
      blockHash: fromHexString("0x701fb2869ce16d0f1d14f6705725adb0dec6799da29006dfc6fff83960298f21"),
    };
    state.eth1DataVotes = (Array.from(
      // minus one so that inserting 1 from block works
      {length: config.params.EPOCHS_PER_ETH1_VOTING_PERIOD * config.params.SLOTS_PER_EPOCH - 1},
      (_, i) => {
        return {
          depositCount: i,
          depositRoot: Buffer.alloc(32, i),
          blockHash: Buffer.alloc(32, i),
        };
      }
    ) as unknown) as List<phase0.Eth1Data>;
    state.eth1DepositIndex = 114038;
    const numValidators = 114038;
    const numKeyPairs = 100;
    const secretKeys = interopSecretKeys(numKeyPairs);
    state.validators = (Array.from({length: numValidators}, (_, i) => {
      return {
        pubkey: secretKeys[i % numKeyPairs].toPublicKey().toBytes(),
        withdrawalCredentials: Buffer.alloc(32, i),
        effectiveBalance: BigInt(31000000000),
        slashed: false,
        activationEligibilityEpoch: 0,
        activationEpoch: 0,
        exitEpoch: Infinity,
        withdrawableEpoch: Infinity,
      };
    }) as unknown) as List<phase0.Validator>;
    state.balances = Array.from({length: numValidators}, () => BigInt(31217089836)) as List<Gwei>;
    state.randaoMixes = Array.from({length: config.params.EPOCHS_PER_HISTORICAL_VECTOR}, (_, i) => Buffer.alloc(32, i));
    // no slashings
    // no attestations
    // no justificationBits
    state.previousJustifiedCheckpoint = {
      epoch: 23635,
      root: fromHexString("0x3fe60bf06a57b0956cd1f8181d26649cf8bf79e48bf82f55562e04b33d4785d4"),
    };
    state.currentJustifiedCheckpoint = {
      epoch: 23636,
      root: fromHexString("0x3ba0913d2fb5e4cbcfb0d39eb15803157c1e769d63b8619285d8fdabbd8181c7"),
    };
    state.finalizedCheckpoint = {
      epoch: 23634,
      root: fromHexString("0x122b8ff579d0c8f8a8b66326bdfec3f685007d2842f01615a0768870961ccc17"),
    };

    archivedState = config.types.phase0.BeaconState.tree.createValue(state);
    logger.info("Loaded state", {
      slot: archivedState.slot,
      numValidators: archivedState.validators.length,
    });
    // cache roots
    archivedState.hashTreeRoot();
  }
  return archivedState.clone();
}

/**
 * This is generated from Medalla block 756417
 */
export async function generatePerformanceBlock(): Promise<TreeBacked<phase0.SignedBeaconBlock>> {
  if (!signedBlock) {
    const block = config.types.phase0.SignedBeaconBlock.defaultValue();
    const parentState = await generatePerformanceState();
    const newState = parentState.clone();
    newState.slot++;
    block.message.slot = newState.slot;
    block.message.proposerIndex = getBeaconProposerIndex(config, newState);
    block.message.parentRoot = config.types.phase0.BeaconBlockHeader.hashTreeRoot(parentState.latestBlockHeader);
    block.message.stateRoot = fromHexString("0x6c86ca3c4c6688cf189421b8a68bf2dbc91521609965e6f4e207d44347061fee");
    block.message.body.randaoReveal = fromHexString(
      "0x8a5d2673c48f22f6ed19462efec35645db490df29eed2f56321dbe4a89b2463b0c902095a7ab74a2dc5b7f67edb1a19507ea3d4361d5af9cb0a524945c91638dfd6568841486813a2c45142659d6d9403f5081febb123a7931edbc248b9d0025"
    );
    // eth1Data, graffiti, attestations
    signedBlock = config.types.phase0.SignedBeaconBlock.tree.createValue(block);
    logger.info("Loaded block", {slot: signedBlock.message.slot});
  }
  return signedBlock.clone();
}

export async function initBLS(): Promise<void> {
  try {
    await init("blst-native");
  } catch (e: unknown) {
    console.warn("Performance warning: Using fallback wasm BLS implementation");
    await init("herumi");
  }
}
