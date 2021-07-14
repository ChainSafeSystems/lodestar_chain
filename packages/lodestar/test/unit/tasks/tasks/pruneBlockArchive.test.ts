import {computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {config} from "@chainsafe/lodestar-config/default";
import {expect} from "chai";
import sinon, {SinonStubbedInstance} from "sinon";
import {IBeaconClock} from "../../../../lib/chain";
import {LocalClock} from "../../../../src/chain/clock";
import {PruneBlockArchiveTask} from "../../../../src/tasks/tasks/pruneBlockArchive";
import {testLogger} from "../../../utils/logger";
import {StubbedBeaconDb} from "../../../utils/stub";

describe("Prune block archive task", function () {
  let dbStub: StubbedBeaconDb;
  let clock: SinonStubbedInstance<IBeaconClock>;

  beforeEach(function () {
    dbStub = new StubbedBeaconDb(sinon, config);
    clock = sinon.createStubInstance(LocalClock);
  });

  it("should delete old blocks", async function () {
    const task = new PruneBlockArchiveTask(config, {db: dbStub, logger: testLogger(), clock});
    sinon.stub(clock, "currentEpoch").get(() => 33024 + 2);
    dbStub.blockArchive.keys.withArgs({lt: computeStartSlotAtEpoch(2)}).resolves([5, 10, 12]);
    await task.run();
    expect(dbStub.blockArchive.batchDelete.withArgs([5, 10, 12]).calledOnce).to.be.true;
  });
});
