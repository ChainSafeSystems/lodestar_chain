import PeerId from "peer-id";
import {Multiaddr} from "multiaddr";
import {IBeaconNodeOptions} from "@chainsafe/lodestar";
import {ENR, createKeypairFromPeerId} from "@chainsafe/discv5";
import {writeFile, readFile} from "../util";
import {FileENR} from "./fileEnr";

export interface IENRJson {
  ip?: string;
  tcp?: number;
  ip6?: string;
  udp?: number;
  tcp6?: number;
  udp6?: number;
}

export function createEnr(peerId: PeerId): ENR {
  const keypair = createKeypairFromPeerId(peerId);
  return ENR.createV4(keypair.publicKey);
}

export function writeEnr(filepath: string, enr: ENR, peerId: PeerId): void {
  const keypair = createKeypairFromPeerId(peerId);
  writeFile(filepath, enr.encodeTxt(keypair.privateKey));
}

export function readEnr(filepath: string): ENR {
  return ENR.decodeTxt(readFile(filepath));
}

export function initEnr(filepath: string, peerId: PeerId): void {
  FileENR.initFromENR(filepath, peerId, createEnr(peerId) as FileENR).saveToFile();
}

export function overwriteEnrWithCliArgs(enr: ENR, enrArgs: IENRJson, options: IBeaconNodeOptions): void {
  if (options.network.localMultiaddrs.length) {
    try {
      const tcpOpts = new Multiaddr(options.network.localMultiaddrs[0]).toOptions();
      if (tcpOpts.transport === "tcp") {
        enr.tcp = tcpOpts.port;
      }
    } catch (e) {
      throw new Error(`Invalid tcp multiaddr: ${(e as Error).message}`);
    }
  }

  if (options.network.discv5?.bindAddr) {
    try {
      const udpOpts = new Multiaddr(options.network.localMultiaddrs[0]).toOptions();
      if (udpOpts.transport === "udp") {
        enr.udp = udpOpts.port;
      }
    } catch (e) {
      throw new Error(`Invalid udp multiaddr: ${(e as Error).message}`);
    }
  }

  if (enrArgs.ip != null) enr.ip = enrArgs.ip;
  if (enrArgs.tcp != null) enr.tcp = enrArgs.tcp;
  if (enrArgs.udp != null) enr.udp = enrArgs.udp;
  if (enrArgs.ip6 != null) enr.ip6 = enrArgs.ip6;
  if (enrArgs.tcp6 != null) enr.tcp6 = enrArgs.tcp6;
  if (enrArgs.udp6 != null) enr.udp6 = enrArgs.udp6;
}
