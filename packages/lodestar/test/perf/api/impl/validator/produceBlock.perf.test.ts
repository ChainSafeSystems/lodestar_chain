import {config} from "@chainsafe/lodestar-config/default";
import {BenchmarkRunner} from "@chainsafe/lodestar-utils/test_utils/benchmark";
import sinon from "sinon";
import {SinonStubbedInstance} from "sinon";
import {ApiModules, getValidatorApi} from "../../../../../src/api";
import {LocalClock} from "../../../../../src/chain/clock";
import {Eth1ForBlockProduction} from "../../../../../src/eth1";
import {IBeaconSync, SyncState} from "../../../../../src/sync";
import {generateBlockSummary, generateEmptyBlock, generateEmptySignedBlock} from "../../../../utils/block";
import {testLogger} from "../../../../utils/logger";
import {setupApiImplTestServer} from "../../../../unit/api/impl/index.test";
import {StateRegenerator} from "../../../../../src/chain/regen";
import {generateCachedState} from "../../../../utils/state";
import {generateEmptyAttestation} from "../../../../utils/attestation";
import {ssz} from "../../../../../../types/lib";
import * as blockBodyAssembly from "../../../../../src/chain/factory/block/body";

describe("produceBlock benchmark", () => {
  const sandbox = sinon.createSandbox();
  const logger = testLogger();
  const currentSlot = 1;

  let syncStub: SinonStubbedInstance<IBeaconSync>;
  let modules: ApiModules;

  before(() => {
    const assembleBodyStub = sandbox.stub(blockBodyAssembly, "assembleBody");
    const eth1Stub = sinon.createStubInstance(Eth1ForBlockProduction);
    const server = setupApiImplTestServer();
    const state = generateCachedState({slot: currentSlot});
    const summary = generateBlockSummary({
      slot: currentSlot,
      blockRoot: ssz.phase0.BeaconBlockHeader.hashTreeRoot(state.latestBlockHeader),
    });
    server.forkChoiceStub.getHead.returns(summary);
    server.chainStub.clock = {currentSlot} as LocalClock;
    const regenStub = (server.chainStub.regen = sandbox.createStubInstance(StateRegenerator));
    regenStub.getBlockSlotState.resolves(state);
    server.dbStub.depositDataRoot.getTreeBacked.resolves(ssz.phase0.DepositDataRootList.defaultTreeBacked());
    assembleBodyStub.resolves(generateEmptyBlock().body);
    server.dbStub.aggregateAndProof.getBlockAttestations.resolves([generateEmptyAttestation()]);
    eth1Stub.getEth1DataAndDeposits.resolves({eth1Data: state.eth1Data, deposits: []});
    modules = {
      chain: server.chainStub,
      config,
      db: server.dbStub,
      eth1: eth1Stub,
      logger,
      network: server.networkStub,
      sync: {...syncStub, state: SyncState.SyncingFinalized},
      metrics: null,
    };
  });

  it("run the benchmark test", async () => {
    const runner = new BenchmarkRunner("produce block", {
      minMs: 1000,
      runs: 1024,
    });

    const api = getValidatorApi(modules);
    const signedBlock = generateEmptySignedBlock();
    await runner.run({
      id: "benchmark produceBlock",
      run: async () => {
        await api.produceBlock(currentSlot, signedBlock.message.body.randaoReveal, "");
      },
    });
  });
});
