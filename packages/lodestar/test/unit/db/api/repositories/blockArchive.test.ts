import {expect} from "chai";
import rimraf from "rimraf";
import {config} from "@chainsafe/lodestar-config/minimal";
import {intToBytes} from "@chainsafe/lodestar-utils";
import {LevelDbController, Bucket, encodeKey} from "@chainsafe/lodestar-db";

import {generateEmptySignedBlock, generateEmptyLightclientSignedBlock} from "../../../../utils/block";
import {BlockArchiveRepository} from "../../../../../src/db/api/beacon/repositories";
import sinon from "sinon";
import {silentLogger} from "../../../../utils/logger";
import {Lightclient} from "@chainsafe/lodestar-types";

describe("block archive repository", function () {
  const testDir = "./.tmp";
  let blockArchive: BlockArchiveRepository;
  let controller: LevelDbController;

  beforeEach(async function () {
    controller = new LevelDbController({name: testDir}, {logger: silentLogger});
    blockArchive = new BlockArchiveRepository(config, controller);
    await controller.start();
  });
  afterEach(async function () {
    await controller.stop();
    rimraf.sync(testDir);
  });

  it("should retrieve blocks in order", async function () {
    await blockArchive.batchPut(
      Array.from({length: 1001}, (_, i) => {
        const slot = i;
        const block = generateEmptySignedBlock();
        block.message.slot = slot;
        return {
          key: slot,
          value: block,
        };
      }),
      config.params.GENESIS_FORK_VERSION
    );
    // test keys
    let lastSlot = 0;
    for await (const slot of blockArchive.keysStream()) {
      expect(slot).to.be.gte(lastSlot);
      lastSlot = slot;
    }

    // test values
    lastSlot = 0;
    for await (const block of blockArchive.valuesStream()) {
      expect(block.message.slot).to.be.gte(lastSlot);
      lastSlot = block.message.slot;
    }

    let blocks;
    // test gte, lte
    blocks = await blockArchive.values({gte: 2, lte: 5});
    expect(blocks.length).to.be.equal(4);
    expect(blocks[0].message.slot).to.be.equal(2);
    expect(blocks[3].message.slot).to.be.equal(5);
    lastSlot = 0;
    for (const block of blocks) {
      expect(block.message.slot).to.be.gt(lastSlot);
      lastSlot = block.message.slot;
    }

    // test gt, lt
    blocks = await blockArchive.values({gt: 2, lt: 6});
    expect(blocks.length).to.be.equal(3);
    expect(blocks[0].message.slot).to.be.equal(3);
    expect(blocks[2].message.slot).to.be.equal(5);
    lastSlot = 0;
    for (const block of blocks) {
      expect(block.message.slot).to.be.gt(lastSlot);
      lastSlot = block.message.slot;
    }

    // test across byte boundaries
    blocks = await blockArchive.values({gte: 200, lt: 400});
    expect(blocks.length).to.be.equal(200);
    expect(blocks[0].message.slot).to.be.equal(200);
    expect(blocks[199].message.slot).to.be.equal(399);
    lastSlot = 0;
    for (const block of blocks) {
      expect(block.message.slot).to.be.gt(lastSlot);
      lastSlot = block.message.slot;
    }

    // test gt until end
    blocks = await blockArchive.values({gt: 700});
    expect(blocks.length).to.be.equal(300);
    expect(blocks[0].message.slot).to.be.equal(701);
    expect(blocks[299].message.slot).to.be.equal(1000);
    lastSlot = 0;
    for (const block of blocks) {
      expect(block.message.slot).to.be.gt(lastSlot);
      lastSlot = block.message.slot;
    }

    // test beginning until lt
    blocks = await blockArchive.values({lte: 200});
    expect(blocks.length).to.be.equal(201);
    expect(blocks[0].message.slot).to.be.equal(0);
    expect(blocks[200].message.slot).to.be.equal(200);
    lastSlot = 0;
    for (const block of blocks) {
      expect(block.message.slot).to.be.gte(lastSlot);
      lastSlot = block.message.slot;
    }
  });

  it("should store indexes when adding single block", async function () {
    const spy = sinon.spy(controller, "put");
    const block = generateEmptySignedBlock();
    await blockArchive.add(block);
    expect(
      spy.withArgs(
        encodeKey(Bucket.blockArchiveRootIndex, config.types.BeaconBlock.hashTreeRoot(block.message)),
        intToBytes(block.message.slot, 64, "be")
      ).calledOnce
    ).to.be.true;
    expect(
      spy.withArgs(
        encodeKey(Bucket.blockArchiveParentRootIndex, block.message.parentRoot.valueOf() as Uint8Array),
        intToBytes(block.message.slot, 64, "be")
      ).calledOnce
    ).to.be.true;
  });

  it("should store indexes when block batch", async function () {
    const spy = sinon.spy(controller, "put");
    const blocks = [generateEmptyLightclientSignedBlock(), generateEmptyLightclientSignedBlock()];
    await blockArchive.batchPut(
      blocks.map((block) => ({key: block.message.slot, value: block})),
      config.params.GENESIS_FORK_VERSION
    );
    expect(
      spy.withArgs(
        encodeKey(Bucket.blockArchiveRootIndex, config.types.BeaconBlock.hashTreeRoot(blocks[0].message)),
        intToBytes(blocks[0].message.slot, 64, "be")
      ).calledTwice
    ).to.be.true;
    expect(
      spy.withArgs(
        encodeKey(Bucket.blockArchiveParentRootIndex, blocks[0].message.parentRoot.valueOf() as Uint8Array),
        intToBytes(blocks[0].message.slot, 64, "be")
      ).calledTwice
    ).to.be.true;
  });

  it("should get slot by root", async function () {
    const block = generateEmptySignedBlock();
    await blockArchive.add(block);
    const slot = await blockArchive.getSlotByRoot(config.types.BeaconBlock.hashTreeRoot(block.message));
    expect(slot).to.equal(block.message.slot);
  });

  it("should get block by root", async function () {
    const block = generateEmptySignedBlock();
    await blockArchive.add(block);
    const retrieved = (await blockArchive.getByRoot(
      config.types.BeaconBlock.hashTreeRoot(block.message)
    )) as Lightclient.SignedBeaconBlock | null;
    if (!retrieved) throw Error("getByRoot returned null");
    expect(config.types.SignedBeaconBlock.equals(retrieved, block)).to.be.true;
  });

  it("should get slot by parent root", async function () {
    const block = generateEmptyLightclientSignedBlock();
    await blockArchive.add(block);
    const slot = await blockArchive.getSlotByParentRoot(block.message.parentRoot);
    expect(slot).to.equal(block.message.slot);
  });

  it("should get block by parent root", async function () {
    const block = generateEmptyLightclientSignedBlock();
    await blockArchive.add(block);
    const retrieved = await blockArchive.getByParentRoot(block.message.parentRoot);
    if (!retrieved) throw Error("getByRoot returned null");
    expect(config.types.SignedBeaconBlock.equals(retrieved, block)).to.be.true;
  });
});