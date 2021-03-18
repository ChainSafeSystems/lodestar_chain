// Uses cross-fetch for browser + NodeJS cross compatibility
// Note: isomorphic-fetch is not well mantained and does not support abort signals
import fetch from "cross-fetch";
import {AbortSignal} from "abort-controller";
import {IJsonRpcClient, IRpcPayload} from "./interface";
import {toJson, toString} from "@chainsafe/lodestar-utils";
import {Json} from "@chainsafe/ssz";

/**
 * Limits the amount of response text printed with RPC or parsing errors
 */
const maxStringLengthToPrint = 500;

interface IRpcResponse<R> extends IRpcResponseError {
  result?: R;
}

interface IRpcResponseError {
  jsonrpc: "2.0";
  id: number;
  error?: {
    code: number; // -32601;
    message: string; // "The method eth_none does not exist/is not available"
  };
}

export class JsonRpcHttpClient implements IJsonRpcClient {
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Perform RPC request
   */
  async fetch<R>(payload: IRpcPayload, signal?: AbortSignal): Promise<R> {
    const res: IRpcResponse<R> = await fetchJson(this.url, {jsonrpc: "2.0", id: 1, ...payload}, signal);
    return parseRpcResponse(res, payload);
  }

  /**
   * Perform RPC batched request
   * Type-wise assumes all requests results have the same type
   */
  async fetchBatch<R>(rpcPayloadArr: IRpcPayload[], signal?: AbortSignal): Promise<R[]> {
    if (rpcPayloadArr.length === 0) return [];

    const resArr: IRpcResponse<R>[] = await fetchJson(
      this.url,
      rpcPayloadArr.map(({method, params}, i) => ({jsonrpc: "2.0", method, params, id: i})),
      signal
    );
    return resArr.map((res, i) => parseRpcResponse(res, rpcPayloadArr[i]));
  }
}

function parseRpcResponse<R>(res: IRpcResponse<R>, payload: IRpcPayload): R {
  if (res.result !== undefined) return res.result;
  throw new ErrorJsonRpcResponse(res, payload);
}

/**
 * Fetches JSON and throws detailed errors in case the HTTP request is not ok
 */
async function fetchJson<R, T = unknown>(url: string, json: T, signal?: AbortSignal): Promise<R> {
  // If url is undefined node-fetch throws with `TypeError: Only absolute URLs are supported`
  // Throw a better error instead
  if (!url) throw Error(`Empty or undefined JSON RPC HTTP client url: ${url}`);

  const res = await fetch(url, {
    method: "post",
    body: JSON.stringify(json),
    headers: {"Content-Type": "application/json"},
    signal,
  });

  const body = await res.text();
  if (!res.ok) {
    throw Error(`${res.status} ${res.statusText}: ${body.slice(0, maxStringLengthToPrint)}`);
  }

  return parseJson(body);
}

/**
 * Util: Parse JSON but display the original source string in case of error
 * Helps debug instances where an API returns a plain text instead of JSON,
 * such as getting an HTML page due to a wrong API URL
 */
function parseJson<T>(json: string): T {
  try {
    return JSON.parse(json);
  } catch (e: unknown) {
    throw new ErrorParseJson(json, e);
  }
}

export class ErrorParseJson extends Error {
  constructor(json: string, e: Error) {
    super(`Error parsing JSON: ${e.message}\n${json.slice(0, maxStringLengthToPrint)}`);
  }
}

export class ErrorJsonRpcResponse extends Error {
  response: IRpcResponseError;
  payload: IRpcPayload;
  constructor(res: IRpcResponseError, payload: IRpcPayload) {
    const errorMessage = res.error
      ? typeof res.error.message === "string"
        ? res.error.message
        : typeof res.error.code === "number"
        ? parseJsonRpcErrorCode(res.error.code)
        : toString(toJson(res.error))
      : "no result";

    super(`JSON RPC error: ${errorMessage}, ${toString(toJson((payload as unknown) as Json))}`);

    this.response = res;
    this.payload = payload;
  }
}

/**
 * JSON RPC spec errors https://www.jsonrpc.org/specification#response_object
 */
function parseJsonRpcErrorCode(code: number): string {
  if (code === -32700) return "Parse request error";
  if (code === -32600) return "Invalid request object";
  if (code === -32601) return "Method not found";
  if (code === -32602) return "Invalid params";
  if (code === -32603) return "Internal error";
  if (code >= -32000 && code <= -32099) return "Server error";
  return `Unknown error code ${code}`;
}
