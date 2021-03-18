/**
 * @module network
 */
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {AbortController} from "abort-controller";
import LibP2p from "libp2p";
import PeerId from "peer-id";
import {IReqResp} from "../interface";
import {IReqRespModules, ReqRespHandler, ILibP2pStream} from "./interface";
import {sendRequest} from "./request";
import {handleRequest} from "./response";
import {Method, ReqRespEncoding, timeoutOptions} from "../../constants";
import {onOutgoingReqRespError} from "./score";
import {IPeerMetadataStore} from "../peers";
import {IPeerRpcScoreStore} from "../peers/score";
import {createRpcProtocol} from "../util";
import {assertSequentialBlocksInRange} from "./utils/assertSequentialBlocksInRange";

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
  private peerMetadata: IPeerMetadataStore;
  private peerRpcScores: IPeerRpcScoreStore;
  private controller: AbortController | undefined;
  private options?: IReqRespOptions;
  private reqCount = 0;
  private respCount = 0;

  /**
   * @see this.registerHandler
   */
  private performRequestHandler: ReqRespHandler | null;

  constructor({config, libp2p, peerMetadata, peerRpcScores, logger}: IReqRespModules, options?: IReqRespOptions) {
    this.config = config;
    this.libp2p = libp2p;
    this.peerMetadata = peerMetadata;
    this.logger = logger;
    this.peerRpcScores = peerRpcScores;
    this.options = options;

    this.performRequestHandler = null;
  }

  start(): void {
    this.controller = new AbortController();
    for (const method of Object.values(Method)) {
      for (const encoding of Object.values(ReqRespEncoding)) {
        this.libp2p.handle(createRpcProtocol(method, encoding), async ({connection, stream}) => {
          const peerId = connection.remotePeer;

          // Store peer encoding preference for this.sendRequest
          if (method === Method.Status) {
            this.peerMetadata.encoding.set(peerId, encoding);
          }

          if (!this.performRequestHandler) {
            stream.close();
            this.logger.error("performRequestHandler not registered", {method, peer: peerId.toB58String()});
            return;
          }

          try {
            await handleRequest(
              {config: this.config, logger: this.logger},
              this.performRequestHandler,
              stream as ILibP2pStream,
              peerId,
              method,
              encoding,
              this.respCount++
            );
            // TODO: Do success peer scoring here
          } catch (e: unknown) {
            // TODO: Do error peer scoring here
            // Must not throw since this is an event handler
          }
        });
      }
    }
  }

  /**
   * ReqResp handler implementers MUST register the requestHandler with this method
   * Then this ReqResp instance will used the registered handler to serve requests
   */
  registerHandler(handler: ReqRespHandler): void {
    if (this.performRequestHandler) {
      throw new Error("Already registered handler");
    }
    this.performRequestHandler = handler;
  }

  unregisterHandler(): ReqRespHandler | null {
    const handler = this.performRequestHandler;
    this.performRequestHandler = null;
    return handler;
  }

  stop(): void {
    for (const method of Object.values(Method)) {
      for (const encoding of Object.values(ReqRespEncoding)) {
        this.libp2p.unhandle(createRpcProtocol(method, encoding));
      }
    }
    this.controller?.abort();
  }

  async status(peerId: PeerId, request: phase0.Status): Promise<phase0.Status> {
    return await this.sendRequest<phase0.Status>(peerId, Method.Status, request);
  }

  async goodbye(peerId: PeerId, request: phase0.Goodbye): Promise<void> {
    await this.sendRequest<phase0.Goodbye>(peerId, Method.Goodbye, request);
  }

  async ping(peerId: PeerId, request: phase0.Ping): Promise<phase0.Ping> {
    return await this.sendRequest<phase0.Ping>(peerId, Method.Ping, request);
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
    maxResponses?: number
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
        this.controller?.signal,
        this.options,
        this.reqCount++
      );

      return result;
    } catch (e: unknown) {
      const peerAction = onOutgoingReqRespError(e, method);
      if (peerAction !== null) this.peerRpcScores.applyAction(peerId, peerAction);

      throw e;
    }
  }
}
