import {assert} from "chai";
import BN from "bn.js";
import {AnyContainerType, deserialize, serialize} from "@chainsafe/ssz";
import {config} from "../../../../src/config/presets/mainnet";

import {
  Method, ProtocolType,
} from "../../../../src/network/hobbits/constants";

import {
  encodeRequestBody,
  decodeRequestBody,
} from "../../../../src/network/hobbits/rpc/codec";

import {
  encodeMessage,
  decodeMessage,
} from "../../../../src/network/hobbits/codec";
import {DecodedMessage} from "../../../../src/network/hobbits/types";

describe("[hobbits] rpc protocol message", () => {
  it(`should properly encode/decode`, () => {
    const msg = {
      reason: new BN(3)
    };
    const id = 0;
    const method = Method.Goodbye;
    // encode
    const body = serialize(msg, config.types.Goodbye);
    const actualEncoded = encodeRequestBody(config, method, msg);
    const encodedMessage = encodeMessage(ProtocolType.RPC, id, method, actualEncoded);

    // decode
    const decodedMessage: DecodedMessage = decodeMessage(encodedMessage);
    // console.log(decodedMessage);
    const requestHeader = decodedMessage.requestHeader;
    const requestBody = decodedMessage.requestBody;
    const decodedBody = decodeRequestBody(config, requestHeader.methodId, requestBody.body);

    // compare
    assert.deepEqual(actualEncoded, body);
    assert.deepEqual(requestBody.body, actualEncoded);
    assert.deepEqual(decodedBody, msg);
  });

});

