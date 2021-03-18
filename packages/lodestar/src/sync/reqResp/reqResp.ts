/**
 * @module sync
 */

import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {ILogger, LodestarError} from "@chainsafe/lodestar-utils";
import PeerId from "peer-id";
import {IBeaconChain} from "../../chain";
import {Method, ReqRespEncoding} from "../../constants";
import {IBeaconDb} from "../../db";
import {createRpcProtocol, INetwork, NetworkEvent} from "../../network";
import {handlePeerMetadataSequence} from "../../network/peers/utils";
import {syncPeersStatus} from "../utils/sync";
import {assertPeerRelevance} from "../utils/assertPeerRelevance";
import {IReqRespHandler} from "./interface";
import {IBeaconMetrics} from "../../metrics";
import {onBeaconBlocksByRange} from "../../network/reqresp/handlers/beaconBlocksByRange";
import {onBeaconBlocksByRoot} from "../../network/reqresp/handlers/beaconBlocksByRoot";

export interface IReqRespHandlerModules {
  config: IBeaconConfig;
  db: IBeaconDb;
  chain: IBeaconChain;
  network: INetwork;
  metrics?: IBeaconMetrics;
  logger: ILogger;
}

enum GoodByeReasonCode {
  CLIENT_SHUTDOWN = 1,
  IRRELEVANT_NETWORK = 2,
  ERROR = 3,
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const GoodbyeReasonCodeDescriptions: Record<string, string> = {
  // spec-defined codes
  1: "Client shutdown",
  2: "Irrelevant network",
  3: "Internal fault/error",

  // Teku-defined codes
  128: "Unable to verify network",

  // Lighthouse-defined codes
  129: "Client has too many peers",
  250: "Peer score too low",
  251: "Peer banned this node",
};

/**
 * The BeaconReqRespHandler module handles app-level requests / responses from other peers,
 * fetching state from the chain and database as needed.
 */
export class BeaconReqRespHandler implements IReqRespHandler {
  private config: IBeaconConfig;
  private db: IBeaconDb;
  private chain: IBeaconChain;
  private network: INetwork;
  private metrics?: IBeaconMetrics;
  private logger: ILogger;

  constructor({config, db, chain, network, metrics, logger}: IReqRespHandlerModules) {
    this.config = config;
    this.db = db;
    this.chain = chain;
    this.network = network;
    this.metrics = metrics;
    this.logger = logger;
  }

  async start(): Promise<void> {
    this.network.reqResp.registerHandler(this.onRequest.bind(this));
    this.network.on(NetworkEvent.peerConnect, this.handshake);
    const myStatus = this.chain.getStatus();
    await syncPeersStatus(this.network, myStatus);
  }

  async stop(): Promise<void> {
    this.network.off(NetworkEvent.peerConnect, this.handshake);
    await Promise.all(
      this.network
        .getPeers({supportsProtocols: [createRpcProtocol(Method.Goodbye, ReqRespEncoding.SSZ_SNAPPY)]})
        .map(async (peer) => {
          try {
            await this.goodbye(peer.id, GoodByeReasonCode.CLIENT_SHUTDOWN);
          } catch (e: unknown) {
            this.logger.verbose("Failed to send goodbye", {error: e.message});
          }
        })
    );
    this.network.reqResp.unregisterHandler();
  }

  async *onRequest(
    method: Method,
    requestBody: phase0.RequestBody,
    peerId: PeerId
  ): AsyncIterable<phase0.ResponseBody> {
    switch (method) {
      case Method.Status:
        yield* this.onStatus(requestBody as phase0.Status, peerId);
        break;
      case Method.Goodbye:
        yield* this.onGoodbye(requestBody as phase0.Goodbye, peerId);
        break;
      case Method.Ping:
        yield* this.onPing(requestBody as phase0.Ping, peerId);
        break;
      case Method.Metadata:
        yield* this.onMetadata();
        break;
      case Method.BeaconBlocksByRange:
        yield* onBeaconBlocksByRange(requestBody as phase0.BeaconBlocksByRangeRequest, this.chain, this.db);
        break;
      case Method.BeaconBlocksByRoot:
        yield* onBeaconBlocksByRoot(requestBody as phase0.BeaconBlocksByRootRequest, this.db);
        break;
      default:
        throw Error(`Unsupported method ${method}`);
    }
  }

  private async *onStatus(status: phase0.Status, peerId: PeerId): AsyncIterable<phase0.Status> {
    try {
      assertPeerRelevance(status, this.chain, this.config);
    } catch (e: unknown) {
      this.logger.debug("Irrelevant peer", {
        peer: peerId.toB58String(),
        reason: e instanceof LodestarError ? e.getMetadata() : e.message,
      });
      await this.goodbye(peerId, GoodByeReasonCode.IRRELEVANT_NETWORK);
      return;
    }

    // set status on peer
    this.network.peerMetadata.status.set(peerId, status);

    // send status response
    yield this.chain.getStatus();
  }

  private async *onGoodbye(goodbyeCode: phase0.Goodbye, peerId: PeerId): AsyncIterable<bigint> {
    const reason = GoodbyeReasonCodeDescriptions[goodbyeCode.toString()] || "";
    this.logger.verbose("Received goodbye request", {peer: peerId.toB58String(), code: goodbyeCode, reason});
    this.metrics?.peerGoodbyeReceived.inc({reason});

    yield BigInt(GoodByeReasonCode.CLIENT_SHUTDOWN);

    // # TODO: Will this line be called if the yield consumer returns? Consider using finally {}
    await this.network.disconnect(peerId);
  }

  private async *onPing(requestBody: phase0.Ping, peerId: PeerId): AsyncIterable<bigint> {
    yield this.network.metadata.seqNumber;

    // # TODO: Will this line be called if the yield consumer returns? Consider using finally {}
    // no need to wait
    handlePeerMetadataSequence(this.network, this.logger, peerId, requestBody).catch(() => {
      this.logger.warn("Failed to handle peer metadata sequence", {peerId: peerId.toB58String()});
    });
  }

  private async *onMetadata(): AsyncIterable<phase0.Metadata> {
    yield this.network.metadata.all;
  }

  private async goodbye(peerId: PeerId, goodbyeCode: GoodByeReasonCode): Promise<void> {
    const reason = GoodbyeReasonCodeDescriptions[goodbyeCode.toString()] || "";
    this.metrics?.peerGoodbyeSent.inc({reason});

    await this.network.reqResp.goodbye(peerId, BigInt(goodbyeCode));
  }

  private handshake = async (peerId: PeerId, direction: "inbound" | "outbound"): Promise<void> => {
    if (direction === "outbound") {
      const request = this.chain.getStatus();
      try {
        this.network.peerMetadata.status.set(peerId, await this.network.reqResp.status(peerId, request));
      } catch (e: unknown) {
        this.logger.verbose("Failed to get peer latest status and metadata", {
          peerId: peerId.toB58String(),
          error: e.message,
        });
        await this.network.disconnect(peerId);
      }
    }
  };
}
