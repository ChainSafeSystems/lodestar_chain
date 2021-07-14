import PeerId from "peer-id";

export function getRandomPeer(peers: PeerId[]): PeerId {
  const peer = peers[Math.floor(Math.random() * peers.length)];
  if (!peer) {
    throw new Error("No more suitable peers");
  }
  return peer;
}
