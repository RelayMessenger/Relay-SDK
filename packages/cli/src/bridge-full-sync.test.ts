import type Relay from "@relaymessenger/sdk";
import { expect, it } from "vitest";
import { runCodexBridge } from "./codex-bridge.js";
import { runClaudeBridge } from "./claude-bridge.js";
import { runAcpBridge } from "./acp-bridge.js";

// A thrown onFullSync does not stop a bridge: the SDK closes the socket,
// reconnects, and Relay re-issues the same FULL sync forever. These processes
// keep no chat copy, so they acknowledge, say so, and answer new messages.
it("acknowledges a FULL sync after telling the operator what was skipped", async () => {
  let completed = 0;
  const said: string[] = [];
  const client = { websocket: { run: async (options: { onFullSync(): Promise<void> }) => {
    await options.onFullSync();
    completed += 1;
  } } } as unknown as Pick<Relay, "chats" | "paymentRequests" | "websocket">;
  const common = { client, cwd: "/unused", signal: new AbortController().signal, say: (line: string) => { said.push(line); } };
  const threads = { get: () => undefined, set: async () => {} };
  await runCodexBridge({ ...common, threads, codex: { command: "unused", args: [] }, agentToken: "unused" });
  await runClaudeBridge({ ...common, threads, claude: { executable: "unused" },
    mcp: { url: "https://unused", token: "unused" } });
  await runAcpBridge({ ...common, sessions: threads, label: "ACP", mcp: { url: "https://unused", token: "unused" },
    acp: { command: "unused", args: [] } });
  expect(completed).toBe(3);
  expect(said).toEqual([
    "Codex was away longer than Relay keeps its messages. It answers the new ones from now on.",
    "Claude Code was away longer than Relay keeps its messages. It answers the new ones from now on.",
    "ACP was away longer than Relay keeps its messages. It answers the new ones from now on.",
  ]);
});
