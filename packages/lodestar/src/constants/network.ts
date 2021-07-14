/* eslint-disable @typescript-eslint/explicit-module-boundary-types */

import {IChainForkConfig} from "@chainsafe/lodestar-config";
import {intDiv} from "@chainsafe/lodestar-utils";

/**
 * For more info on some of these constants:
 * https://github.com/ethereum/eth2.0-specs/blob/dev/specs/phase0/p2p-interface.md#configuration
 */

// Gossip constants

/**
 * The maximum number of slots during which an attestation can be propagated.
 */
export const ATTESTATION_PROPAGATION_SLOT_RANGE = 23;

//  Request/Response constants

export enum RespStatus {
  /**
   * A normal response follows, with contents matching the expected message schema and encoding specified in the request
   */
  SUCCESS = 0,
  /**
   * The contents of the request are semantically invalid, or the payload is malformed,
   * or could not be understood. The response payload adheres to the ErrorMessage schema
   */
  INVALID_REQUEST = 1,
  /**
   * The responder encountered an error while processing the request. The response payload adheres to the ErrorMessage schema
   */
  SERVER_ERROR = 2,
  /**
   * The responder does not have requested resource.  The response payload adheres to the ErrorMessage schema (described below). Note: This response code is only valid as a response to BlocksByRange
   */
  RESOURCE_UNAVAILABLE = 3,
}

export type RpcResponseStatusError = Exclude<RespStatus, RespStatus.SUCCESS>;

/** The maximum allowed size of uncompressed gossip messages. */
export const GOSSIP_MAX_SIZE = 2 ** 20;

// source: https://github.com/ethereum/eth2.0-specs/blob/f52f067b8ea3f8adbebc936207b06459d1956e72/specs/phase0/p2p-interface.md#why-are-blocksbyrange-requests-only-required-to-be-served-for-the-latest-min_epochs_for_block_requests-epochs
export function getMinEpochForBlockRequests(config: IChainForkConfig): number {
  return config.MIN_VALIDATOR_WITHDRAWABILITY_DELAY + intDiv(config.CHURN_LIMIT_QUOTIENT, 2);
}

/** The maximum allowed size of uncompressed req/resp chunked responses. */
export const MAX_CHUNK_SIZE = 2 ** 20;
/** The maximum time to wait for first byte of request response (time-to-first-byte). */
export const TTFB_TIMEOUT = 5 * 1000; // 5 sec
/** The maximum time for complete response transfer. */
export const RESP_TIMEOUT = 10 * 1000; // 10 sec
/** Non-spec timeout from sending request until write stream closed by responder */
export const REQUEST_TIMEOUT = 5 * 1000; // 5 sec
/** Non-spec timeout from dialing protocol until stream opened */
export const DIAL_TIMEOUT = 5 * 1000; // 5 sec
// eslint-disable-next-line @typescript-eslint/naming-convention
export const timeoutOptions = {TTFB_TIMEOUT, RESP_TIMEOUT, REQUEST_TIMEOUT, DIAL_TIMEOUT};

export enum GoodByeReasonCode {
  CLIENT_SHUTDOWN = 1,
  IRRELEVANT_NETWORK = 2,
  ERROR = 3,
  TOO_MANY_PEERS = 129,
  SCORE_TOO_LOW = 250,
  BANNED = 251,
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const GOODBYE_KNOWN_CODES: Record<string, string> = {
  0: "Unknown",

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

/** Until js-libp2p types its events */
export enum Libp2pEvent {
  peerConnect = "peer:connect",
  peerDisconnect = "peer:disconnect",
}
