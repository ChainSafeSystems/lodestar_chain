import varint from "varint";
import {source} from "stream-to-it";
import {createCompressStream} from "@chainsafe/snappy-stream";
import {RequestOrResponseBody, RequestOrResponseType} from "../../interface";
import {SszSnappyError, SszSnappyErrorCode} from "./errors";

/**
 * ssz_snappy encoding strategy writer.
 * Yields byte chunks for encoded header and payload as defined in the spec:
 * ```
 * <encoding-dependent-header> | <encoded-payload>
 * ```
 */
export async function* writeSszSnappyPayload<T extends RequestOrResponseBody>(
  body: T,
  type: RequestOrResponseType
): AsyncGenerator<Buffer> {
  const serializedBody = serializeSszBody(body, type);

  // MUST encode the length of the raw SSZ bytes, encoded as an unsigned protobuf varint
  yield Buffer.from(varint.encode(serializedBody.length));

  // By first computing and writing the SSZ byte length, the SSZ encoder can then directly
  // write the chunk contents to the stream. Snappy writer compresses frame by frame
  yield* encodeSszSnappy(serializedBody);
}

/**
 * Buffered Snappy writer
 */
function encodeSszSnappy(bytes: Buffer): AsyncGenerator<Buffer> {
  const stream = createCompressStream();
  stream.write(bytes);
  stream.end();
  return source<Buffer>(stream);
}

/**
 * Returns SSZ serialized body. Wrapps errors with SszSnappyError.SERIALIZE_ERROR
 */
function serializeSszBody<T extends RequestOrResponseBody>(body: T, type: RequestOrResponseType): Buffer {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bytes = type.serialize(body as any);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  } catch (e: unknown) {
    throw new SszSnappyError({code: SszSnappyErrorCode.SERIALIZE_ERROR, serializeError: e});
  }
}
