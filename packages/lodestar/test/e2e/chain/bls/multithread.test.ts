import chai, {expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import {AbortController} from "@chainsafe/abort-controller";
import {bls} from "@chainsafe/bls";
import {ISignatureSet, SignatureSetType} from "@chainsafe/lodestar-beacon-state-transition";
import {BlsMultiThreadWorkerPool} from "../../../../src/chain/bls/multithread";
import {testLogger} from "../../../utils/logger";
import {VerifySignatureOpts} from "../../../../src/chain/bls/interface";

chai.use(chaiAsPromised);

describe("chain / bls / multithread queue", function () {
  this.timeout(30 * 1000);
  const logger = testLogger();

  let controller: AbortController;
  beforeEach(() => (controller = new AbortController()));
  afterEach(() => controller.abort());

  const sets: ISignatureSet[] = [];
  before("generate test data", () => {
    for (let i = 0; i < 3; i++) {
      const sk = bls.SecretKey.fromBytes(Buffer.alloc(32, i + 1));
      const msg = Buffer.alloc(32, i + 1);
      const pk = sk.toPublicKey();
      const sig = sk.sign(msg);
      sets.push({
        type: SignatureSetType.single,
        pubkey: pk,
        signingRoot: msg,
        signature: sig.toBytes(),
      });
    }
  });

  async function initializePool(): Promise<BlsMultiThreadWorkerPool> {
    const pool = new BlsMultiThreadWorkerPool({logger, metrics: null, signal: controller.signal});
    // Wait until initialized
    await pool["waitTillInitialized"]();
    return pool;
  }

  async function testManyValidSignatures(
    testOpts: {sleep?: boolean},
    verifySignatureOpts?: VerifySignatureOpts
  ): Promise<void> {
    const pool = await initializePool();

    const isValidPromiseArr: Promise<boolean>[] = [];
    for (let i = 0; i < 8; i++) {
      isValidPromiseArr.push(pool.verifySignatureSets(sets, verifySignatureOpts));
      if (testOpts.sleep) {
        // Tick forward so the pool sends a job out
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    const isValidArr = await Promise.all(isValidPromiseArr);
    for (const [i, isValid] of isValidArr.entries()) {
      expect(isValid).to.equal(true, `sig set ${i} returned invalid`);
    }
  }

  it("Should verify multiple signatures submited syncronously", async () => {
    // Given the `setTimeout(this.runJob, 0);` all sets should be verified in a single job an worker
    await testManyValidSignatures({sleep: false});
  });

  it("Should verify multiple signatures submited asyncronously", async () => {
    // Because of the sleep, each sets submitted should be verified in a different job and worker
    await testManyValidSignatures({sleep: true});
  });

  it("Should verify multiple signatures batched", async () => {
    // By setting batchable: true, 5*8 = 40 sig sets should be verified in one job, while 3*8=24 should
    // be verified in another job
    await testManyValidSignatures({sleep: true}, {batchable: true});
  });

  it("Should verify multiple signatures batched, first is invalid", async () => {
    // If the first signature is invalid it should not make the rest throw
    const pool = await initializePool();

    const invalidSet: ISignatureSet = {...sets[0], signature: Buffer.alloc(32, 0)};
    const isInvalidPromise = pool.verifySignatureSets([invalidSet], {batchable: true});
    const isValidPromiseArr: Promise<boolean>[] = [];
    for (let i = 0; i < 8; i++) {
      isValidPromiseArr.push(pool.verifySignatureSets(sets, {batchable: true}));
    }

    await expect(isInvalidPromise).to.rejectedWith("BLST_ERROR");

    const isValidArr = await Promise.all(isValidPromiseArr);
    for (const [i, isValid] of isValidArr.entries()) {
      expect(isValid).to.equal(true, `sig set ${i} returned invalid`);
    }
  });
});
