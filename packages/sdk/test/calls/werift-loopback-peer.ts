import type { RTCPeerConnection } from "werift";
import type { RelayPeerConnectionLike, RelayWebRTCFactory } from "../../src/calls/transport.js";

/**
 * One werift peer of a loopback pair, reachable on 127.0.0.1.
 *
 * werift gathers host candidates only from non-internal interfaces and drops
 * loopback, veth, tun and tap ones, and these pairs set no STUN server. On a
 * laptop the Wi-Fi address carries the pair; in a container sandbox (Daytona)
 * every interface is dropped, so no candidate exists and both peers stay in
 * `new`. Offering 127.0.0.1 as well (werift's `iceAdditionalHostAddresses`,
 * set through the W3C `setConfiguration`) connects the pair everywhere.
 */
export const loopbackPeer = (factory: RelayWebRTCFactory): RelayPeerConnectionLike => {
  const peer = factory.createPeerConnection();
  (peer as unknown as RTCPeerConnection).setConfiguration({ iceAdditionalHostAddresses: ["127.0.0.1"] });
  return peer;
};
