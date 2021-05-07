import LibP2p from "libp2p";
import PeerId from "peer-id";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {phase0} from "@chainsafe/lodestar-types";
import {ILogger} from "@chainsafe/lodestar-utils";
import {Method, Methods} from "../../constants";
import {IPeerMetadataStore, IPeerRpcScoreStore} from "../peers";
import {MetadataController} from "../metadata";
import {INetworkEventBus} from "../events";
import {IReqRespHandler} from "./handlers";

export interface IReqResp {
  start(): void;
  stop(): void;
  status(peerId: PeerId, request: phase0.Status): Promise<phase0.Status>;
  goodbye(peerId: PeerId, request: phase0.Goodbye): Promise<void>;
  ping(peerId: PeerId): Promise<phase0.Ping>;
  metadata(peerId: PeerId): Promise<phase0.Metadata>;
  beaconBlocksByRange(peerId: PeerId, request: phase0.BeaconBlocksByRangeRequest): Promise<phase0.SignedBeaconBlock[]>;
  beaconBlocksByRoot(peerId: PeerId, request: phase0.BeaconBlocksByRootRequest): Promise<phase0.SignedBeaconBlock[]>;
}

export interface IReqRespModules {
  config: IBeaconConfig;
  libp2p: LibP2p;
  logger: ILogger;
  metadata: MetadataController;
  reqRespHandler: IReqRespHandler;
  peerMetadata: IPeerMetadataStore;
  peerRpcScores: IPeerRpcScoreStore;
  networkEventBus: INetworkEventBus;
}

export type RequestOrResponseType = Exclude<
  ReturnType<typeof Methods[Method]["responseSSZType"]> | ReturnType<typeof Methods[Method]["requestSSZType"]>,
  null
>;

export type RequestOrResponseBody = phase0.ResponseBody | phase0.RequestBody;
