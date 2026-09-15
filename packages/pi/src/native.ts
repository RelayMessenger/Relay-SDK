import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runPiChannel } from "./index.js";

let controller: AbortController | undefined;
let running: Promise<void> | undefined;

/**
 * Pi-native entry point. It deliberately exposes only lifecycle-safe commands;
 * Relay ingress remains owned by runPiChannel so the CLI and extension share
 * the same authenticated routing implementation.
 */
export default function relayPiExtension(pi: ExtensionAPI): void {
  pi.registerCommand("relay-connect", {
    description: "Start the Relay channel using the configured Agent Token",
    handler: async (_args, ctx) => {
      if (running) {
        ctx.ui.notify("Relay Pi channel is already running.", "info");
        return;
      }
      const agentToken = process.env.RELAY_AGENT_TOKEN?.trim();
      if (!agentToken) {
        ctx.ui.notify("RELAY_AGENT_TOKEN is not configured.", "error");
        return;
      }
      controller = new AbortController();
      running = runPiChannel({ agentToken }, controller.signal).catch((error: unknown) => {
        ctx.ui.notify(`Relay Pi channel stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
      }).finally(() => {
        running = undefined;
        controller = undefined;
      });
      ctx.ui.notify("Relay Pi channel started.", "info");
    },
  });
  pi.registerCommand("relay-disconnect", {
    description: "Stop the Relay channel started by the Relay CLI",
    handler: async (_args, ctx) => {
      controller?.abort();
      ctx.ui.notify("Relay Pi channel stopping.", "info");
    },
  });
}
