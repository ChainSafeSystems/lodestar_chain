import {expect} from "chai";
import {createFromPrivKey} from "peer-id";
import {fromHexString, toHexString} from "@chainsafe/ssz";
import {createPeerId} from "../../../src/network";

describe("PeerId util - for multiprocess sim test", () => {
  it("Should serialize and deserialize privKey", async () => {
    const peerId = await createPeerId();
    const privKey = peerId.marshalPrivKey();
    const privKeyHex = toHexString(privKey);
    const peerIdRecov = await createFromPrivKey(fromHexString(privKeyHex));
    expect(peerId.toB58String()).to.equal(peerIdRecov.toB58String());
  });
});
