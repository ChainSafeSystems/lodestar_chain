import chai, {expect} from "chai";
import chaiAsPromised from "chai-as-promised";
import {config} from "@chainsafe/lodestar-config/mainnet";
import {phase0} from "@chainsafe/lodestar-types";
import all from "it-all";
import PeerId from "peer-id";
import sinon, {SinonStubbedInstance} from "sinon";
import {GENESIS_EPOCH, Method, ZERO_HASH} from "../../../src/constants";
import {IBeaconDb} from "../../../src/db/api";
import {Network} from "../../../src/network";
import {ReqResp} from "../../../src/network/reqresp/reqResp";
import {BeaconReqRespHandler} from "../../../src/sync/reqResp";
import {BeaconMetrics} from "../../../src/metrics";
import {generateEmptySignedBlock} from "../../utils/block";
import {getBlockSummary} from "../../utils/headBlockInfo";
import {testLogger} from "../../utils/logger";
import {generatePeer} from "../../utils/peer";
import {generateState} from "../../utils/state";
import {StubbedBeaconChain, StubbedBeaconDb} from "../../utils/stub";
import {getStubbedMetadataStore, StubbedIPeerMetadataStore} from "../../utils/peer";

chai.use(chaiAsPromised);

describe("sync req resp", function () {
  const peerId = new PeerId(Buffer.from("lodestar"));
  const logger = testLogger();
  const sandbox = sinon.createSandbox();
  const metrics = sandbox.createStubInstance(BeaconMetrics);
  metrics.peerGoodbyeReceived = {inc: sinon.stub()} as any;
  let syncRpc: BeaconReqRespHandler;
  let chainStub: StubbedBeaconChain,
    networkStub: SinonStubbedInstance<Network>,
    metaStub: StubbedIPeerMetadataStore,
    reqRespStub: SinonStubbedInstance<ReqResp>;
  let dbStub: StubbedBeaconDb;

  beforeEach(() => {
    chainStub = new StubbedBeaconChain(sandbox, config);
    chainStub.forkChoice.getHead.returns(getBlockSummary({}));
    chainStub.forkChoice.getFinalizedCheckpoint.returns({epoch: GENESIS_EPOCH, root: ZERO_HASH});
    chainStub.getHeadState = sandbox.stub().returns(generateState());
    // @ts-ignore
    chainStub.config = config;
    chainStub.getForkDigest = sandbox.stub().returns(Buffer.alloc(4));
    reqRespStub = sandbox.createStubInstance(ReqResp);
    networkStub = sandbox.createStubInstance(Network);
    networkStub.reqResp = reqRespStub as ReqResp & SinonStubbedInstance<ReqResp>;
    metaStub = getStubbedMetadataStore();
    networkStub.peerMetadata = metaStub;
    dbStub = new StubbedBeaconDb(sandbox);

    syncRpc = new BeaconReqRespHandler({
      config,
      db: (dbStub as unknown) as IBeaconDb,
      chain: chainStub,
      network: networkStub,
      metrics,
      logger,
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it("should start and stop sync rpc", async function () {
    const peerId = new PeerId(Buffer.from("lodestar"));
    networkStub.hasPeer.returns(true);
    networkStub.getPeers.returns([generatePeer(peerId), generatePeer(peerId)]);

    await syncRpc.start();
    await syncRpc.stop();
  });

  it("should handle request - onStatus", async function () {
    const body: phase0.Status = {
      forkDigest: Buffer.alloc(4),
      finalizedRoot: Buffer.alloc(32),
      finalizedEpoch: 1,
      headRoot: Buffer.alloc(32),
      headSlot: 1,
    };
    chainStub.stateCache.get.returns(generateState() as any);
    chainStub.clock = {currentSlot: 0} as any;

    const res = await all(syncRpc.onRequest(Method.Status, body, peerId));
    expect(res).have.length(1, "Wrong number of chunks responded");
    expect(reqRespStub.goodbye.called).to.be.false;
  });

  it("should handle request - onGoodbye", async function () {
    const goodbye: phase0.Goodbye = BigInt(1);
    networkStub.disconnect.resolves();

    await all(syncRpc.onRequest(Method.Goodbye, goodbye, peerId));

    // expect(networkStub.disconnect.calledOnce).to.be.true;
  });

  it("Throw if BeaconBlocksByRangeRequest is invalid", async function () {
    const peerId = new PeerId(Buffer.from("lodestar"));
    const requestBody: phase0.BeaconBlocksByRangeRequest = {
      step: 0,
      startSlot: 0,
      count: 10,
    };

    await expect(all(syncRpc.onRequest(Method.BeaconBlocksByRange, requestBody, peerId))).to.be.rejectedWith(
      "step < 1"
    );
  });

  it("should handle request - onBeaconBlocksByRange", async function () {
    const peerId = new PeerId(Buffer.from("lodestar"));
    const requestBody: phase0.BeaconBlocksByRangeRequest = {
      startSlot: 2,
      count: 4,
      step: 2,
    };
    dbStub.blockArchive.valuesStream.returns(
      (async function* () {
        for (const slot of [2, 4]) {
          const block = generateEmptySignedBlock();
          block.message.slot = slot;
          yield block;
        }
      })()
    );
    const block8 = generateEmptySignedBlock();
    block8.message.slot = 8;
    // block 6 does not exist
    chainStub.getUnfinalizedBlocksAtSlots = sandbox.stub().resolves([null!, block8]);

    const slots: number[] = [];
    try {
      for await (const chunk of syncRpc.onRequest(Method.BeaconBlocksByRange, requestBody, peerId)) {
        slots.push((chunk as phase0.SignedBeaconBlock).message.slot);
      }
    } catch (e: unknown) {
      console.log({e});
      //
    }

    // count is 4 but it returns only 3 blocks because block 6 does not exist
    expect(slots).to.be.deep.equal([2, 4, 8]);
  });
});
