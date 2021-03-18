import PeerId from "peer-id";
import pipe from "it-pipe";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Context, ILogger} from "@chainsafe/lodestar-utils";
import {Method, ReqRespEncoding, RpcResponseStatus} from "../../../constants";
import {onChunk} from "../utils/onChunk";
import {ILibP2pStream, ReqRespHandler} from "../interface";
import {requestDecode} from "../encoders/requestDecode";
import {responseEncodeError, responseEncodeSuccess} from "../encoders/responseEncode";
import {ResponseError} from "./errors";

export {ResponseError};

/**
 * Handles a ReqResp request from a peer. Throws on error. Logs each step of the response lifecycle.
 *
 * 1. A duplex `stream` with the peer is already available
 * 2. Read and decode request from peer
 * 3. Delegate to `performRequestHandler()` to perform the request job and expect
 *    to yield zero or more `<response_chunks>`
 * 4a. Encode and write `<response_chunks>` to peer
 * 4b. On error, encode and write an error `<response_chunk>` and stop
 */
export async function handleRequest(
  {config, logger}: {config: IBeaconConfig; logger: ILogger},
  performRequestHandler: ReqRespHandler,
  stream: ILibP2pStream,
  peerId: PeerId,
  method: Method,
  encoding: ReqRespEncoding,
  requestId = 0
): Promise<void> {
  const logCtx = {method, encoding, peer: peerId.toB58String(), requestId};

  let responseError: Error | null = null;
  await pipe(
    // Yields success chunks and error chunks in the same generator
    // This syntax allows to recycle stream.sink to send success and error chunks without returning
    // in case request whose body is a List fails at chunk_i > 0, without breaking out of the for..await..of
    (async function* () {
      try {
        const requestBody = await pipe(stream.source, requestDecode(config, method, encoding)).catch((e) => {
          throw new ResponseError(RpcResponseStatus.INVALID_REQUEST, e.message);
        });

        logger.debug("Resp received request", {...logCtx, requestBody} as Context);

        yield* pipe(
          performRequestHandler(method, requestBody, peerId),
          // NOTE: Do not log the resp chunk contents, logs get extremely cluttered
          onChunk(() => logger.debug("Resp sending chunk", logCtx)),
          responseEncodeSuccess(config, method, encoding)
        );
      } catch (e: unknown) {
        const status = e instanceof ResponseError ? e.status : RpcResponseStatus.SERVER_ERROR;
        yield* responseEncodeError(status, e.message);

        // Should not throw an error here or libp2p-mplex throws with 'AbortError: stream reset'
        // throw e;
        responseError = e;
      }
    })(),
    stream.sink
  );

  // If streak.sink throws, libp2p-mplex will close stream.source
  // If `requestDecode()` throws the stream.source must be closed manually
  // To ensure the stream.source it-pushable instance is always closed, stream.close() is called always
  stream.close();

  // TODO: It may happen that stream.sink returns before returning stream.source first,
  // so you never see "Resp received request" in the logs and the response ends without
  // sending any chunk, triggering EMPTY_RESPONSE error on the requesting side
  // It has only happened when doing a request too fast upon immediate connection on inbound peer
  // investigate a potential race condition there

  if (responseError) {
    logger.verbose("Resp error", logCtx, responseError);
    throw responseError;
  } else {
    logger.verbose("Resp done", logCtx);
  }
}
