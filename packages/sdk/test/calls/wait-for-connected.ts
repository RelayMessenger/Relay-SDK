import type { RelayPeerConnectionLike } from "../../src/calls/transport.js";

/**
 * Watches one peer of a hand-wired werift pair from the start, so no state
 * change is missed, and starts the clock only at `within()`, once both
 * descriptions are set: gathering is not part of the budget.
 *
 * A werift peer with no STUN server still queries stun.l.google.com:19302
 * (werift ice.ts `Connection` defaults `stunServer` to it), and gathering
 * waits up to 5 s for that answer. Where it never comes (a Daytona sandbox,
 * measured 2026-09-30: 5.0 s per peer) the pair connects about 10.1 s after
 * the offer, so a clock started before gathering ran out with the peer still
 * `new`, though ICE itself connected in about 0.2 s.
 */
export const waitForConnected = (peer: RelayPeerConnectionLike) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fail: (error: Error) => void = () => {};
  const connected = new Promise<void>((resolve, reject) => {
    fail = reject;
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "connected") {
        clearTimeout(timer);
        resolve();
      } else if (peer.connectionState === "failed") {
        clearTimeout(timer);
        reject(new Error("peer connection failed"));
      }
    };
  });
  return {
    within: (ms = 10_000): Promise<void> => {
      timer = setTimeout(() => fail(new Error(`peer stuck in ${peer.connectionState}`)), ms);
      return connected;
    },
  };
};
