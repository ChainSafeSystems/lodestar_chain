import {AbortController} from "abort-controller";
import {source as abortSource} from "abortable-iterator";
import pipe from "it-pipe";
import {timeoutOptions} from "../../../constants";
import {onChunk} from "../utils/onChunk";
import {RequestErrorCode, RequestInternalError} from "./errors";

/**
 * Wraps responseDecoder to isolate the logic that handles response timeouts.
 * - TTFB_TIMEOUT: The requester MUST wait a maximum of TTFB_TIMEOUT for the first response byte to arrive
 * - RESP_TIMEOUT: Requester allows a further RESP_TIMEOUT for each subsequent response_chunk
 */
export function responseTimeoutsHandler<T>(
  responseDecoder: (source: AsyncIterable<Buffer>) => AsyncGenerator<T>,
  options?: Partial<typeof timeoutOptions>
): (source: AsyncIterable<Buffer>) => AsyncGenerator<T> {
  return async function* (source) {
    const {TTFB_TIMEOUT, RESP_TIMEOUT} = {...timeoutOptions, ...options};

    const ttfbTimeoutController = new AbortController();
    const respTimeoutController = new AbortController();

    const timeoutTTFB = setTimeout(() => ttfbTimeoutController.abort(), TTFB_TIMEOUT);
    let timeoutRESP: NodeJS.Timeout | null = null;
    let isFirstByte = true;

    const restartRespTimeout = (): void => {
      if (timeoutRESP) clearTimeout(timeoutRESP);
      timeoutRESP = setTimeout(() => respTimeoutController.abort(), RESP_TIMEOUT);
    };

    try {
      yield* pipe(
        abortSource(source, [
          {signal: ttfbTimeoutController.signal, options: {abortMessage: RequestErrorCode.TTFB_TIMEOUT}},
          {signal: respTimeoutController.signal, options: {abortMessage: RequestErrorCode.RESP_TIMEOUT}},
        ]),
        onChunk((bytesChunk) => {
          // Ignore null and empty chunks
          if (isFirstByte && bytesChunk.length > 0) {
            isFirstByte = false;
            // On first byte, cancel the single use TTFB_TIMEOUT, and start RESP_TIMEOUT
            clearTimeout(timeoutTTFB);
            restartRespTimeout();
          }
        }),

        responseDecoder,
        onChunk(() => {
          // On <response_chunk>, cancel this chunk's RESP_TIMEOUT and start next's
          restartRespTimeout();
        })
      );
    } catch (e: unknown) {
      // Rethrow error properly typed so the peer score can pick it up
      switch (e.message) {
        case RequestErrorCode.TTFB_TIMEOUT:
          throw new RequestInternalError({code: RequestErrorCode.TTFB_TIMEOUT});
        case RequestErrorCode.RESP_TIMEOUT:
          throw new RequestInternalError({code: RequestErrorCode.RESP_TIMEOUT});
        default:
          throw e;
      }
    } finally {
      clearTimeout(timeoutTTFB);
      if (timeoutRESP) clearTimeout(timeoutRESP);
    }
  };
}
