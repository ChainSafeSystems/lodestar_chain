import {expect} from "chai";
import {AbortController} from "@chainsafe/abort-controller";
import {bls} from "@chainsafe/bls";
import {ISignatureSet, SignatureSetType} from "@chainsafe/lodestar-beacon-state-transition";
import {BlsMultiThreadWorkerPool} from "../../../../src/chain/bls/multithread";
import {testLogger} from "../../../utils/logger";

describe("chain / bls / multithread queue", function () {
  this.timeout(30 * 1000);
  const logger = testLogger();

  let controller: AbortController;
  beforeEach(() => (controller = new AbortController()));
  afterEach(() => controller.abort());

  it("Should verify some signatures", async () => {
    const sets: ISignatureSet[] = [];
    for (let i = 0; i < 8; i++) {
      const sk = bls.SecretKey.fromBytes(Buffer.alloc(32, i + 1));
      const msg = Buffer.alloc(32, i);
      const pk = sk.toPublicKey();
      const sig = sk.sign(msg);
      sets.push({
        type: SignatureSetType.single,
        pubkey: pk,
        signingRoot: msg,
        signature: sig.toBytes(),
      });
    }

    const pool = new BlsMultiThreadWorkerPool({logger, metrics: null, signal: controller.signal});
    const isValidArr = await Promise.all(Array.from({length: 8}, (i) => i).map(() => pool.verifySignatureSets(sets)));
    for (const [i, isValid] of isValidArr.entries()) {
      expect(isValid).to.equal(true, `sig set ${i} returned invalid`);
    }
  });
});
