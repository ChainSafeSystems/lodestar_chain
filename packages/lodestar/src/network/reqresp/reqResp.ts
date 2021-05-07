/**
 * @module network
 */
import {HandlerProps} from "libp2p";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {AbortController} from "abort-controller";
import LibP2p from "libp2p";
import PeerId from "peer-id";
import {IReqResp, IReqRespModules} from "./interface";
import {sendRequest} from "./request";
import {handleRequest} from "./response";
import {Method, ReqRespEncoding, timeoutOptions} from "../../constants";
import {onOutgoingReqRespError} from "./score";
import {IPeerMetadataStore, IPeerRpcScoreStore} from "../peers";
import {createRpcProtocol} from "../util";
import {assertSequentialBlocksInRange} from "./utils/assertSequentialBlocksInRange";
import {MetadataController} from "../metadata";
import {INetworkEventBus, NetworkEvent} from "../events";
import {IReqRespHandler} from "./handlers";

export type IReqRespOptions = Partial<typeof timeoutOptions>;

/**
 * Implementation of eth2 p2p Req/Resp domain.
 * For the spec that this code is based on, see:
 * https://github.com/ethereum/eth2.0-specs/blob/dev/specs/phase0/p2p-interface.md#the-reqresp-domain
 */
export class ReqResp implements IReqResp {
  private config: IBeaconConfig;
  private libp2p: LibP2p;
  private logger: ILogger;
  private reqRespHandler: IReqRespHandler;
  private metadataController: MetadataController;
  private peerMetadata: IPeerMetadataStore;
  private peerRpcScores: IPeerRpcScoreStore;
  private networkEventBus: INetworkEventBus;
  private controller = new AbortController();
  private options?: IReqRespOptions;
  private reqCount = 0;
  private respCount = 0;

  constructor(modules: IReqRespModules, options?: IReqRespOptions) {
    this.config = modules.config;
    this.libp2p = modules.libp2p;
    this.logger = modules.logger;
    this.reqRespHandler = modules.reqRespHandler;
    this.peerMetadata = modules.peerMetadata;
    this.metadataController = modules.metadata;
    this.peerRpcScores = modules.peerRpcScores;
    this.networkEventBus = modules.networkEventBus;
    this.options = options;
  }

  start(): void {
    this.controller = new AbortController();
    for (const method of Object.values(Method)) {
      for (const encoding of Object.values(ReqRespEncoding)) {
        this.libp2p.handle(createRpcProtocol(method, encoding), async ({connection, stream}: HandlerProps) => {
          const peerId = connection.remotePeer;

          // TODO: Do we really need this now that there is only one encoding?
          // Remember the prefered encoding of this peer
          if (method === Method.Status) {
            this.peerMetadata.encoding.set(peerId, encoding);
          }

          try {
            await handleRequest(
              {config: this.config, logger: this.logger, libp2p: this.libp2p},
              this.onRequest.bind(this),
              stream,
              peerId,
              method,
              encoding,
              this.controller.signal,
              this.respCount++
            );
            // TODO: Do success peer scoring here
          } catch {
            // TODO: Do error peer scoring here
            // Must not throw since this is an event handler
          }
        });
      }
    }
  }

  stop(): void {
    for (const method of Object.values(Method)) {
      for (const encoding of Object.values(ReqRespEncoding)) {
        this.libp2p.unhandle(createRpcProtocol(method, encoding));
      }
    }
    this.controller.abort();
  }

  async status(peerId: PeerId, request: phase0.Status): Promise<phase0.Status> {
    return await this.sendRequest<phase0.Status>(peerId, Method.Status, request);
  }

  async goodbye(peerId: PeerId, request: phase0.Goodbye): Promise<void> {
    await this.sendRequest<phase0.Goodbye>(peerId, Method.Goodbye, request);
  }

  async ping(peerId: PeerId): Promise<phase0.Ping> {
    return await this.sendRequest<phase0.Ping>(peerId, Method.Ping, this.metadataController.seqNumber);
  }

  async metadata(peerId: PeerId): Promise<phase0.Metadata> {
    return await this.sendRequest<phase0.Metadata>(peerId, Method.Metadata, null);
  }

  async beaconBlocksByRange(
    peerId: PeerId,
    request: phase0.BeaconBlocksByRangeRequest
  ): Promise<phase0.SignedBeaconBlock[]> {
    const blocks = await this.sendRequest<phase0.SignedBeaconBlock[]>(
      peerId,
      Method.BeaconBlocksByRange,
      request,
      request.count
    );
    assertSequentialBlocksInRange(blocks, request);
    return blocks;
  }

  async beaconBlocksByRoot(
    peerId: PeerId,
    request: phase0.BeaconBlocksByRootRequest
  ): Promise<phase0.SignedBeaconBlock[]> {
    return await this.sendRequest<phase0.SignedBeaconBlock[]>(
      peerId,
      Method.BeaconBlocksByRoot,
      request,
      request.length
    );
  }

  // Helper to reduce code duplication
  private async sendRequest<T extends phase0.ResponseBody | phase0.ResponseBody[]>(
    peerId: PeerId,
    method: Method,
    body: phase0.RequestBody,
    maxResponses = 1
  ): Promise<T> {
    try {
      const encoding = this.peerMetadata.encoding.get(peerId) ?? ReqRespEncoding.SSZ_SNAPPY;
      const result = await sendRequest<T>(
        {libp2p: this.libp2p, logger: this.logger, config: this.config},
        peerId,
        method,
        encoding,
        body,
        maxResponses,
        this.controller.signal,
        this.options,
        this.reqCount++
      );

      return result;
    } catch (e) {
      const peerAction = onOutgoingReqRespError(e as Error, method);
      if (peerAction !== null) this.peerRpcScores.applyAction(peerId, peerAction);

      throw e;
    }
  }

  private async *onRequest(
    method: Method,
    requestBody: phase0.RequestBody,
    peerId: PeerId
  ): AsyncIterable<phase0.ResponseBody> {
    switch (method) {
      case Method.Ping:
        yield this.metadataController.seqNumber;
        break;

      case Method.Metadata:
        yield this.metadataController.all;
        break;

      case Method.Goodbye:
        yield BigInt(0);
        break;

      // Don't bubble Ping, Metadata, and, Goodbye requests to the app layer

      case Method.Status:
        yield* this.reqRespHandler.onStatus();
        break;
      case Method.BeaconBlocksByRange:
        yield* this.reqRespHandler.onBeaconBlocksByRange(requestBody);
        break;
      case Method.BeaconBlocksByRoot:
        yield* this.reqRespHandler.onBeaconBlocksByRoot(requestBody);
        break;

      default:
        throw Error(`Unsupported method ${method}`);
    }

    // Allow onRequest to return and close the stream
    // For Goodbye there may be a race condition where the listener of `receivedGoodbye`
    // disconnects in the same syncronous call, preventing the stream from ending cleanly
    setTimeout(() => this.networkEventBus.emit(NetworkEvent.reqRespRequest, method, requestBody, peerId), 0);
  }
}
