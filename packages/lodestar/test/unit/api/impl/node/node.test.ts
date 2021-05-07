/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import {Connection} from "libp2p";
import {INodeApi} from "../../../../../src/api/impl/node";
import {NodeApi} from "../../../../../src/api/impl/node/node";
import sinon, {SinonStubbedInstance} from "sinon";
import {createPeerId, INetwork, Network} from "../../../../../src/network";
import {BeaconSync, IBeaconSync} from "../../../../../src/sync";
import {createKeypairFromPeerId, ENR} from "@chainsafe/discv5/lib";
import PeerId from "peer-id";
import {expect, use} from "chai";
import chaiAsPromised from "chai-as-promised";
import {Multiaddr} from "multiaddr";
import {MetadataController} from "../../../../../src/network/metadata";
import {phase0} from "@chainsafe/lodestar-types";
import {NodePeer} from "../../../../../src/api/types";
import {PeerStatus, PeerDirection} from "../../../../../src/network";

use(chaiAsPromised);

interface IPeerSummary {
  direction: string | null;
  state: string;
  hasPeerId: boolean;
  hasP2pAddress: boolean;
}

const toPeerSummary = (peer: NodePeer): IPeerSummary => {
  return {
    direction: peer.direction,
    state: peer.state,
    hasPeerId: !peer.peerId ? false : peer.peerId.length > 0,
    hasP2pAddress: !peer.lastSeenP2pAddress ? false : peer.lastSeenP2pAddress.length > 0,
  };
};

describe("node api implementation", function () {
  let api: INodeApi;
  let networkStub: SinonStubbedInstance<INetwork>;
  let syncStub: SinonStubbedInstance<IBeaconSync>;
  let peerId: PeerId;

  beforeEach(async function () {
    networkStub = sinon.createStubInstance(Network);
    syncStub = sinon.createStubInstance(BeaconSync);
    api = new NodeApi({}, {network: networkStub, sync: syncStub});
    peerId = await PeerId.create({keyType: "secp256k1"});
    sinon.stub(networkStub, "peerId").get(() => peerId);
    sinon.stub(networkStub, "localMultiaddrs").get(() => [new Multiaddr("/ip4/127.0.0.1/tcp/36000")]);
  });

  describe("getNodeIdentity", function () {
    it("should get node identity", async function () {
      const keypair = createKeypairFromPeerId(peerId);
      const enr = ENR.createV4(keypair.publicKey);
      enr.setLocationMultiaddr(new Multiaddr("/ip4/127.0.0.1/tcp/36001"));
      networkStub.getEnr.returns(enr);
      networkStub.metadata = {
        get all(): phase0.Metadata {
          return {
            attnets: [true],
            seqNumber: BigInt(1),
          };
        },
      } as MetadataController;
      const identity = await api.getNodeIdentity();
      expect(identity.peerId.startsWith("16")).to.be.true;
      expect(identity.enr.startsWith("enr:-")).to.be.true;
      expect(identity.discoveryAddresses.length).to.equal(1);
      expect(identity.discoveryAddresses[0]).to.equal("/ip4/127.0.0.1/tcp/36001");
      expect(identity.p2pAddresses.length).to.equal(1);
      expect(identity.p2pAddresses[0]).to.equal("/ip4/127.0.0.1/tcp/36000");
      expect(identity.metadata).to.not.null;
    });

    it("should get node identity - no enr", async function () {
      networkStub.getEnr.returns(null!);
      const identity = await api.getNodeIdentity();
      expect(identity.enr).equal("");
    });
  });

  describe("getNodeStatus", function () {
    it("syncing", async function () {
      syncStub.isSynced.returns(false);
      const status = await api.getNodeStatus();
      expect(status).to.equal("syncing");
    });

    it("ready", async function () {
      syncStub.isSynced.resolves(true);
      const status = await api.getNodeStatus();
      expect(status).to.equal("ready");
    });
  });

  describe("getPeers", function () {
    let peer1: PeerId, peer2: PeerId;

    before(async function () {
      peer1 = await createPeerId();
      peer2 = await createPeerId();
    });

    it("should return connected and disconnecting peers", async function () {
      const connectionsByPeer = new Map<string, Connection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "open", "outbound")]],
        [peer2.toB58String(), [libp2pConnection(peer2, "closing", "inbound")]],
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peers = await api.getPeers();
      expect(peers.length).to.equal(2);
      expect(peers.map(toPeerSummary)).to.be.deep.equal([
        {direction: "outbound", state: "connected", hasP2pAddress: true, hasPeerId: true},
        {direction: "inbound", state: "disconnecting", hasPeerId: true, hasP2pAddress: true},
      ]);
    });

    it("should return disconnected peers", async function () {
      const connectionsByPeer = new Map<string, Connection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "closed", "outbound")]],
        [peer2.toB58String(), []], // peer2 has no connections in the connection manager
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peers = await api.getPeers();
      // expect(peers[0].enr).not.empty;
      expect(peers.map(toPeerSummary)).to.be.deep.equal([
        {direction: "outbound", state: "disconnected", hasPeerId: true, hasP2pAddress: true},
        {direction: null, state: "disconnected", hasPeerId: true, hasP2pAddress: false},
      ]);
    });
  });

  describe("getPeer", function () {
    it("success", async function () {
      const peer1 = await createPeerId();
      const peer2 = await createPeerId();
      const connectionsByPeer = new Map<string, Connection[]>([
        [peer1.toB58String(), [libp2pConnection(peer1, "open", "outbound")]],
        [peer2.toB58String(), [libp2pConnection(peer2, "closing", "inbound")]],
      ]);
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);

      const peer = await api.getPeer(peer1.toB58String());
      if (!peer) throw Error("getPeer returned no peer");
      expect(peer.peerId).to.equal(peer1.toB58String());
      expect(peer.lastSeenP2pAddress).not.empty;
      expect(peer.peerId).not.empty;
      // expect(peers[0].enr).not.empty;
      expect(peer.direction).to.equal("outbound");
      expect(peer.state).to.equal("connected");
    });

    it("peer not found", async function () {
      const connectionsByPeer = new Map<string, Connection[]>();
      networkStub.getConnectionsByPeer.returns(connectionsByPeer);
      await expect(api.getPeer("not existent")).to.be.rejectedWith();
    });
  });

  describe("getSyncStatus", function () {
    it("success", async function () {
      syncStub.getSyncStatus.resolves({
        headSlot: BigInt(2),
        syncDistance: BigInt(1),
      });
      const syncStatus = await api.getSyncingStatus();
      expect(syncStatus.headSlot.toString()).to.equal("2");
      expect(syncStatus.syncDistance.toString()).to.equal("1");
    });
  });

  describe("getVersion", function () {
    it("success", async function () {
      const version = await api.getVersion();
      expect(version.startsWith("Lodestar")).to.be.true;
    });
  });
});

export function libp2pConnection(peer: PeerId, status: PeerStatus, direction: PeerDirection): Connection {
  return {
    remoteAddr: new Multiaddr(),
    stat: {
      status,
      direction,
    },
    remotePeer: peer,
  } as Connection;
}
