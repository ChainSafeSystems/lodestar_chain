import {sleep} from "@chainsafe/lodestar-utils";

export interface IRetryOptions {
  /**
   * The maximum amount of times to retry the operation. Default is 5
   */
  retries?: number;
  /**
   * An optional Function that is invoked after the provided callback throws
   * It expects a boolean to know if it should retry or not
   * Useful to make retrying conditional on the type of error thrown
   */
  shouldRetry?: (lastError: Error) => boolean;
  /**
   * Callback on each error
   */
  onError?: (error: Error, attempt: number) => unknown;
  /**
   * wait between retries N miliseconds
   */
  waitBetweenRetriesMs?: number;
}

/**
 * Retry a given function on error.
 * @param fn Async callback to retry. Invoked with 1 parameter
 * A Number identifying the attempt. The absolute first attempt (before any retries) is 1
 * @param opts
 */
export async function retry<A>(fn: (attempt: number) => A | Promise<A>, opts?: IRetryOptions): Promise<A> {
  const maxRetries = opts?.retries || 5;
  const shouldRetry = opts?.shouldRetry;

  let lastError: Error = Error("No error");
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastError = e as Error;
      if (opts?.onError) opts?.onError(e, i);
      if (shouldRetry && !shouldRetry(lastError)) {
        break;
      }
      if (opts?.waitBetweenRetriesMs !== undefined) {
        await sleep(opts?.waitBetweenRetriesMs);
      }
    }
  }

  lastError.message = `${lastError.message} - [RetryError ${maxRetries} retries]`;
  throw lastError;
}
