import type Relay from "@relaymessenger/sdk";
import { expect, it } from "vitest";
import { runCodexBridge } from "./codex-bridge.js";
import { runClaudeBridge } from "./claude-bridge.js";
import { runAcpBridge } from "./acp-bridge.js";

it("never acknowledges a FULL sync without rebuilding the skipped selection inbox", async () => {
  let completed = 0;
  const client = { websocket: { run: async (options: { onFullSync(): Promise<void> }) => {
    await options.onFullSync();
    completed += 1;
  } } } as unknown as Pick<Relay, "chats" | "websocket">;
  const common = { client, cwd: "/unused", signal: new AbortController().signal, say: () => {} };
  const threads = { get: () => undefined, set: async () => {} };
  await expect(runCodexBridge({ ...common, threads, codex: { command: "unused", args: [] } }))
    .rejects.toThrow("cannot acknowledge FULL sync");
  await expect(runClaudeBridge({ ...common, threads, claude: { executable: "unused" },
    mcpServer: { command: "unused", args: [], env: {} } }))
    .rejects.toThrow("cannot acknowledge FULL sync");
  await expect(runAcpBridge({ ...common, sessions: threads, label: "ACP", mcpServers: [],
    acp: { command: "unused", args: [] } }))
    .rejects.toThrow("cannot acknowledge FULL sync");
  expect(completed).toBe(0);
});
