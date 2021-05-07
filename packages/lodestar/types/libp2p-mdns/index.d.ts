// Type definitions for libp2p-mdns 0.16.0
// Project: https://github.com/libp2p/js-libp2p-mdns

declare module 'libp2p-mdns' {
  import { PeerDiscoveryFactory } from 'libp2p-interfaces/src/peer-discovery/types';

  const mdns: PeerDiscoveryFactory;
  export default mdns;
}