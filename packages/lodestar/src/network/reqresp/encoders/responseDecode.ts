import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {Method, Methods, ReqRespEncoding, RpcResponseStatus} from "../../../constants";
import {BufferedSource} from "../utils/bufferedSource";
import {readEncodedPayload} from "../encodingStrategies";
import {decodeErrorMessage} from "../utils/errorMessage";
import {ResponseError} from "../response";

/**
 * Internal helper type to signal stream ended early
 */
enum StreamStatus {
  Ended = "STREAM_ENDED",
}

/**
 * Consumes a stream source to read a `<response>`
 * ```bnf
 * response        ::= <response_chunk>*
 * response_chunk  ::= <result> | <encoding-dependent-header> | <encoded-payload>
 * result          ::= "0" | "1" | "2" | ["128" ... "255"]
 * ```
 */
export function responseDecode(
  config: IBeaconConfig,
  method: Method,
  encoding: ReqRespEncoding
): (source: AsyncIterable<Buffer>) => AsyncGenerator<phase0.ResponseBody> {
  return async function* (source) {
    const type = Methods[method].responseSSZType(config);
    const isSszTree = method === Method.BeaconBlocksByRange || method === Method.BeaconBlocksByRoot;

    const bufferedSource = new BufferedSource(source as AsyncGenerator<Buffer>);

    // Consumers of `responseDecode()` may limit the number of <response_chunk> and break out of the while loop
    while (!bufferedSource.isDone) {
      const status = await readResultHeader(bufferedSource);

      // Stream is only allowed to end at the start of a <response_chunk> block
      // The happens when source ends before readResultHeader() can fetch 1 byte
      if (status === StreamStatus.Ended) {
        break;
      }

      // For multiple chunks, only the last chunk is allowed to have a non-zero error
      // code (i.e. The chunk stream is terminated once an error occurs
      if (status !== RpcResponseStatus.SUCCESS) {
        const errorMessage = await readErrorMessage(bufferedSource);
        throw new ResponseError(status, errorMessage);
      }

      yield await readEncodedPayload<phase0.ResponseBody>(bufferedSource, encoding, type, {isSszTree});
    }
  };
}

/**
 * Consumes a stream source to read a `<result>`
 * ```bnf
 * result  ::= "0" | "1" | "2" | ["128" ... "255"]
 * ```
 * `<response_chunk>` starts with a single-byte response code which determines the contents of the response_chunk
 */
export async function readResultHeader(bufferedSource: BufferedSource): Promise<RpcResponseStatus | StreamStatus> {
  for await (const buffer of bufferedSource) {
    const status = buffer.get(0);
    buffer.consume(1);

    // If first chunk had zero bytes status === null, get next
    if (status !== null) {
      return status;
    }
  }

  return StreamStatus.Ended;
}

/**
 * Consumes a stream source to read an optional `<error_response>?`
 * ```bnf
 * error_response  ::= <result> | <error_message>?
 * result          ::= "1" | "2" | ["128" ... "255"]
 * ```
 */
export async function readErrorMessage(bufferedSource: BufferedSource): Promise<string> {
  for await (const buffer of bufferedSource) {
    // Wait for next chunk with bytes or for the stream to end
    // Note: The entire <error_message> is expected to be in the same chunk
    if (buffer.length === 0) {
      continue;
    }

    const bytes = buffer.slice();
    try {
      return decodeErrorMessage(bytes);
    } catch (e: unknown) {
      return bytes.toString("hex");
    }
  }

  // Error message is optional and may not be included in the response stream
  return "";
}
