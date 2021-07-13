import {ENR, IDiscv5DiscoveryInputOptions} from "@chainsafe/discv5";
import {PeerManagerOpts} from "./peers";

export interface INetworkOptions extends PeerManagerOpts {
  localMultiaddrs: string[];
  bootMultiaddrs: string[];
  discv5?: IDiscv5DiscoveryInputOptions;
  subscribeAllSubnets?: boolean;
}

export const defaultDiscv5Options: IDiscv5DiscoveryInputOptions = {
  bindAddr: "/ip4/0.0.0.0/udp/9000",
  enr: new ENR(),
  bootEnrs: [],
  enrUpdate: true,
  enabled: true,
};

export const defaultNetworkOptions: INetworkOptions = {
  maxPeers: 30, // Allow some room above targetPeers for new inbound peers
  targetPeers: 25,
  localMultiaddrs: ["/ip4/0.0.0.0/tcp/9000"],
  bootMultiaddrs: [],
  discv5: defaultDiscv5Options,
};
