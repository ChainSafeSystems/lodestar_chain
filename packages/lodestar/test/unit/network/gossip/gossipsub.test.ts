import {expect, assert} from "chai";
import Libp2p from "libp2p";
import {InMessage} from "libp2p-interfaces/src/pubsub";
import {ERR_TOPIC_VALIDATOR_REJECT} from "libp2p-gossipsub/src/constants";
import {config} from "@chainsafe/lodestar-config/minimal";

import {
  Eth2Gossipsub,
  getGossipTopicString,
  GossipType,
  TopicValidatorFn,
  GossipValidationError,
  encodeMessageData,
  GossipEncoding,
} from "../../../../src/network/gossip";

import {generateEmptySignedBlock} from "../../../utils/block";
import {createNode} from "../../../utils/network";
import {testLogger} from "../../../utils/logger";

describe("gossipsub", function () {
  let validatorFns: Map<string, TopicValidatorFn>;
  let gossipSub: Eth2Gossipsub;
  let message: InMessage;
  let topicString: string;
  let libp2p: Libp2p;
  const genesisValidatorsRoot = Buffer.alloc(32);

  beforeEach(async function () {
    const signedBlock = generateEmptySignedBlock();
    topicString = getGossipTopicString(config, {type: GossipType.beacon_block, fork: "phase0"}, genesisValidatorsRoot);
    message = {
      data: encodeMessageData(GossipEncoding.ssz_snappy, config.types.phase0.SignedBeaconBlock.serialize(signedBlock)),
      receivedFrom: "0",
      topicIDs: [topicString],
    };

    validatorFns = new Map();
    const multiaddr = "/ip4/127.0.0.1/tcp/0";
    libp2p = await createNode(multiaddr);
  });

  it("should throw on failed validation", async () => {
    validatorFns.set(topicString, () => {
      throw new GossipValidationError(ERR_TOPIC_VALIDATOR_REJECT);
    });
    gossipSub = new Eth2Gossipsub({config, genesisValidatorsRoot, validatorFns, logger: testLogger(), libp2p});

    try {
      await gossipSub.validate(message);
      assert.fail("Expect error here");
    } catch (e: unknown) {
      expect(e.code).to.be.equal(ERR_TOPIC_VALIDATOR_REJECT);
    }
  });

  it("should not throw on successful validation", async () => {
    gossipSub = new Eth2Gossipsub({config, genesisValidatorsRoot, validatorFns, logger: testLogger(), libp2p});
    await gossipSub.validate(message);
    // no error means pass validation
  });
});
