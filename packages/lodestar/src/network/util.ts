/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @module network
 */

import PeerId from "peer-id";
import {Method, MethodResponseType, Methods, ReqRespEncoding, RequestId} from "../constants";
import {Multiaddr} from "multiaddr";
import {networkInterfaces} from "os";
import {ENR} from "@chainsafe/discv5";
import MetadataBook from "libp2p/src/peer-store/metadata-book";
import {IBeaconConfig, IForkInfo} from "@chainsafe/lodestar-config";
import {Epoch} from "@chainsafe/lodestar-types";

// req/resp

export function createResponseEvent(id: RequestId): string {
  return `response ${id}`;
}

/**
 * Render protocol ID
 */
export function createRpcProtocol(method: Method, encoding: ReqRespEncoding, version = 1): string {
  return `/eth2/beacon_chain/req/${method}/${version}/${encoding}`;
}

export function parseProtocolId(protocolId: string): {method: Method; encoding: ReqRespEncoding; version: number} {
  const suffix = protocolId.split("eth2/beacon_chain/req/")[1];
  if (!suffix) throw Error(`Invalid protocolId: ${protocolId}`);

  const [method, version, encoding] = suffix.split("/");
  return {
    method: method as Method,
    version: parseInt(version),
    encoding: encoding as ReqRespEncoding,
  };
}

// peers

/**
 * Return a fresh PeerId instance
 */
export async function createPeerId(): Promise<PeerId> {
  return await PeerId.create({bits: 256, keyType: "secp256k1"});
}

export function isRequestSingleChunk(method: Method): boolean {
  return Methods[method].responseType === MethodResponseType.SingleResponse;
}

export function getStatusProtocols(): string[] {
  return [createRpcProtocol(Method.Status, ReqRespEncoding.SSZ_SNAPPY)];
}

export function getSyncProtocols(): string[] {
  return [createRpcProtocol(Method.BeaconBlocksByRange, ReqRespEncoding.SSZ_SNAPPY)];
}

export function getUnknownRootProtocols(): string[] {
  return [createRpcProtocol(Method.BeaconBlocksByRoot, ReqRespEncoding.SSZ_SNAPPY)];
}

/**
 * Check if multiaddr belongs to the local network interfaces.
 */
export function isLocalMultiAddr(multiaddr: Multiaddr | undefined): boolean {
  if (!multiaddr) return false;

  const protoNames = multiaddr.protoNames();
  if (protoNames.length !== 2 && protoNames[1] !== "udp") {
    throw new Error("Invalid udp multiaddr");
  }

  const interfaces = networkInterfaces();
  const tuples = multiaddr.tuples();
  const isIPv4: boolean = tuples[0][0] === 4;
  const family = isIPv4 ? "IPv4" : "IPv6";
  const ip = tuples[0][1];

  if (!ip) {
    return false;
  }

  const ipStr = isIPv4
    ? Array.from(ip).join(".")
    : Array.from(Uint16Array.from(ip))
        .map((n) => n.toString(16))
        .join(":");

  for (const networkInterfaces of Object.values(interfaces)) {
    for (const networkInterface of networkInterfaces || []) {
      if (networkInterface.family === family && networkInterface.address === ipStr) {
        return true;
      }
    }
  }

  return false;
}

export function clearMultiaddrUDP(enr: ENR): void {
  // enr.multiaddrUDP = undefined in new version
  enr.delete("ip");
  enr.delete("udp");
  enr.delete("ip6");
  enr.delete("udp6");
}

export function prettyPrintPeerId(peerId: PeerId): string {
  const id = peerId.toB58String();
  return `${id.substr(0, 2)}...${id.substr(id.length - 6, id.length)}`;
}

export function getAgentVersionFromPeerStore(peerId: PeerId, metadataBook: MetadataBook): string {
  return new TextDecoder().decode(metadataBook.getValue(peerId, "AgentVersion")) || "N/A";
}

export function getCurrentAndNextFork(
  config: IBeaconConfig,
  epoch: Epoch
): {currentFork: IForkInfo; nextFork: IForkInfo | undefined} {
  // NOTE: forks are sorted by ascending epoch, phase0 first
  const forks = Object.values(config.forks);
  let currentForkIdx = -1;
  // findLastIndex
  for (let i = 0; i < forks.length; i++) {
    if (epoch >= forks[i].epoch) currentForkIdx = i;
  }
  const nextForkIdx = currentForkIdx + 1;
  const hasNextFork = forks[nextForkIdx] && forks[nextForkIdx].epoch !== Infinity;
  return {
    currentFork: forks[currentForkIdx] || forks[0],
    nextFork: hasNextFork ? forks[nextForkIdx] : undefined,
  };
}
