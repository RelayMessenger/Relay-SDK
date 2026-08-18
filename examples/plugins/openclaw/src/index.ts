/**
 * Thin re-export surface for an OpenClaw-oriented Relay channel.
 * Full OpenClaw plugin SDK wiring (channel-inbound/outbound adapters, gateway
 * harness) still lives in relaymessenger/cli integrations/openclaw until that
 * package is migrated here. This entry lets new code depend on core today.
 */
export {
  createFileCursorStore,
  createRelayClient,
  MemoryDedupe,
  runPollLoop,
  type MessageHandlerContext,
  type RelayClient,
} from "@relaymessenger/sdk";

export const OPENCLAW_RELAY_CHANNEL_ID = "relay" as const;
