import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  acpCommand, acpPrompt, autoPermission, relayMcpServer, replyKey, runAcpBridge,
  type AcpCommand,
} from "./acp-bridge.js";
import { openAcpSessions, type AcpSessionStore } from "./acp-threads.js";
import { platformCommand } from "./spawn-command.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

const scratch = async (name: string): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), `relay-${name}-`));
  folders.push(folder);
  return folder;
};

/** One line the fake agent wrote down: a message in, or a notification out. */
interface FakeLine {
  in?: string;
  out?: string;
  params?: Record<string, unknown>;
  argv?: string[];
}

/** The Relay MCP server connect would build, reduced to what the bridge passes on. */
const RELAY_MCP = { command: "npx", args: ["-y", "@relaymessenger/mcp@staging", "--profile", "calm.dev"], env: {} as Record<string, string> };

/**
 * An agent whose ACP command is the script beside this test. It is started
 * exactly as the real one is, through `spawnCommand`, so this covers the
 * Windows line too: an extensionless script is not a program on Windows, and
 * this one is run by this very Node.
 */
const fakeAcpAgent = async (settings: {
  answers?: string[];
  turnMs?: number;
  loadSession?: boolean;
  resumable?: string[];
} = {}): Promise<{ acp: AcpCommand; cwd: string; log(): Promise<FakeLine[]> }> => {
  const folder = await scratch("fake-acp");
  const record = join(folder, "messages.jsonl");
  const settingsPath = join(folder, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ record, ...settings }), "utf8");
  const script = fileURLToPath(new URL("./acp-agent.fake.cjs", import.meta.url));
  return {
    // `<node> <fake> <settings> acp`: the last word stands in for the ACP
    // sub-command real agents take (`cursor-agent acp`, `opencode acp`).
    acp: { command: process.execPath, args: [script, settingsPath, "acp"] },
    cwd: folder,
    log: async () => {
      const written = await readFile(record, "utf8").catch(() => "");
      return written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLine);
    },
  };
};

/** What the fake agent was asked to do, and what it announced, in order. */
const traffic = (log: FakeLine[]): string[] =>
  log.map((line) => line.in ?? `out ${line.out ?? ""}`);

const received = (eventId: string, chatId: string, text: string, sender = "alice.dev"): RelayWebhookEvent => ({
  api_version: "v1", webhook_version: "2026-08-30", event_type: "message.received",
  event_id: eventId, created_at: "2026-09-11T00:00:00.000Z", trace_id: "trace", agent_id: "agent",
  data: {
    chat: { id: chatId }, id: "message", direction: "inbound",
    sender_handle: { id: "sender", handle: sender, kind: "user" },
    parts: [{ type: "text", value: text, reactions: null }],
  },
} as unknown as RelayWebhookEvent);

/** Relay, reduced to what the bridge touches, with every call written down. */
function fakeRelay(events: readonly RelayWebhookEvent[]) {
  const typing: string[] = [];
  const sent: Array<{ chatId: string; text: string; key: string | undefined }> = [];
  let sendFails = false;
  const client = {
    chats: {
      startTyping: async (chatID: string) => { typing.push(`start ${chatID}`); },
      stopTyping: async (chatID: string) => { typing.push(`stop ${chatID}`); },
      messages: {
        send: async (chatID: string, body: { message: { parts: Array<{ value?: string }>; idempotency_key?: string } }) => {
          if (sendFails) throw new Error("Relay refused this send.");
          sent.push({ chatId: chatID, text: body.message.parts[0]?.value ?? "", key: body.message.idempotency_key });
          return {} as never;
        },
      },
    },
    websocket: {
      run: async (options: { onEvent(event: RelayWebhookEvent, context: { sequence: string }): Promise<void> }) => {
        for (const [index, event] of events.entries()) await options.onEvent(event, { sequence: String(index + 1) });
      },
    },
  } as unknown as Pick<Relay, "chats" | "websocket">;
  return { client, typing, sent, failSends: () => { sendFails = true; } };
}

/** Every way one message can end on the terminal. */
const ENDED = /Sent the answer|gave no answer|did not reach Relay|was dropped/u;

const untilEnded = async (said: readonly string[], count: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (said.filter((line) => ENDED.test(line)).length >= count) return;
    if (Date.now() > deadline) throw new Error(`Only these messages ended: ${said.join(" | ")}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/** The session ids, kept in memory, for the tests that are not about the file. */
const memorySessions = (): AcpSessionStore => {
  const sessions = new Map<string, string>();
  return {
    get: (chatId) => sessions.get(chatId),
    set: async (chatId, sessionId) => { sessions.set(chatId, sessionId); },
  };
};

/** One run of the bridge over one list of events, stopped once they have ended. */
const runBridge = async (input: {
  acp: AcpCommand;
  cwd: string;
  events: readonly RelayWebhookEvent[];
  sessions?: AcpSessionStore;
  endings?: number;
  relay?: ReturnType<typeof fakeRelay>;
  mcpServers?: ReturnType<typeof relayMcpServer>[];
}): Promise<{ said: string[]; relay: ReturnType<typeof fakeRelay> }> => {
  const relay = input.relay ?? fakeRelay(input.events);
  const said: string[] = [];
  const control = new AbortController();
  try {
    await runAcpBridge({
      client: relay.client, acp: input.acp, cwd: input.cwd,
      mcpServers: input.mcpServers ?? [relayMcpServer(RELAY_MCP)],
      label: "Cursor",
      sessions: input.sessions ?? memorySessions(),
      signal: control.signal, say: (line) => said.push(line),
    });
    await untilEnded(said, input.endings ?? input.events.length);
  } finally { control.abort(); }
  return { said, relay };
};

describe("the ACP agent the bridge starts", () => {
  it("says hello the way the protocol asks, before it prompts anything", async () => {
    const acp = await fakeAcpAgent();
    await runBridge({ ...acp, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const log = await acp.log();
    expect(traffic(log).slice(0, 3)).toEqual(["initialize", "session/new", "session/prompt"]);
    // The sub-command is the last word on the line, after whatever runs the
    // stand-in: `<agent> acp`.
    expect(log[0]!.argv?.at(-1)).toBe("acp");
    expect(log[0]!.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "relaymessenger", title: "Relay", version: expect.any(String) },
    });
  });

  it("opens a session in the folder and hands it the Relay MCP server", async () => {
    const acp = await fakeAcpAgent();
    await runBridge({ ...acp, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const start = (await acp.log()).find((line) => line.in === "session/new");
    expect(start?.params).toEqual({
      cwd: acp.cwd,
      mcpServers: [{
        name: "relay", command: "npx",
        args: ["-y", "@relaymessenger/mcp@staging", "--profile", "calm.dev"], env: [],
      }],
    });
  });

  it("sends the message as the prompt's text, and never on a command line", async () => {
    const acp = await fakeAcpAgent();
    await runBridge({ ...acp, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const prompt = (await acp.log()).find((line) => line.in === "session/prompt");
    expect(prompt?.params).toEqual({
      sessionId: "session-1",
      prompt: [{ type: "text", text: acpPrompt("alice.dev", "Hey, what's up") }],
    });
  });

  it("tells the agent the answer travels back on its own", () => {
    expect(acpPrompt("alice.dev", "Hey, what's up")).toContain("@alice.dev sent you this message on Relay:");
    expect(acpPrompt("alice.dev", "Hey, what's up")).toContain("do not send it yourself");
  });

  it("takes the message that arrived as the key, so one message is answered once", () => {
    expect(replyKey("0199e0d0-0000-7000-8000-000000000001")).toBe("acp-bridge-0199e0d0-0000-7000-8000-000000000001");
  });
});

describe("the ACP command the bridge starts", () => {
  it("takes the Windows shim npm installs, because Windows has no file called cursor-agent", async () => {
    const folder = await scratch("cursor-path");
    await writeFile(join(folder, "cursor-agent.cmd"), "@echo off\r\n", "utf8");
    expect(await acpCommand("cursor-agent", ["acp"], { PATH: folder }, "win32"))
      .toEqual({ command: join(folder, "cursor-agent.cmd"), args: ["acp"] });
  });

  it("leaves a Windows name the shell can find when nothing is on PATH", async () => {
    expect(await acpCommand("cursor-agent", ["acp"], { PATH: "" }, "win32"))
      .toEqual({ command: "cursor-agent.cmd", args: ["acp"] });
  });

  it("keeps the file connect already found, with the ACP words it was given", async () => {
    const found = join(tmpdir(), "bin", "gemini");
    expect(await acpCommand(found, ["--experimental-acp"], { PATH: "" }, "darwin"))
      .toEqual({ command: found, args: ["--experimental-acp"] });
  });

  it("runs a Windows shim through the shell, and a program itself", () => {
    expect(platformCommand("C:\\bin\\cursor-agent.cmd", ["acp"], "win32")).toEqual({
      file: '^"C:\\bin\\cursor-agent.cmd^"', args: ['^"acp^"'], shell: true,
    });
    expect(platformCommand("/usr/local/bin/gemini", ["--experimental-acp"], "darwin")).toEqual({
      file: "/usr/local/bin/gemini", args: ["--experimental-acp"], shell: false,
    });
  });
});

describe("what the bridge sends back", () => {
  it("sends the answer the turn ended with, and shows typing while it works", async () => {
    const acp = await fakeAcpAgent({ answers: ["Not much. Your README says this is a test project."] });
    const { said, relay } = await runBridge({ ...acp, events: [received("event-1", "chat-1", "Hey, what's up")] });
    expect(relay.sent).toEqual([{
      chatId: "chat-1",
      text: "Not much. Your README says this is a test project.",
      key: "acp-bridge-event-1",
    }]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said).toEqual(["@alice.dev  Hey, what's up", "Sent the answer to @alice.dev."]);
  });

  it("sends nothing when the agent answers with nothing, and says so", async () => {
    const acp = await fakeAcpAgent({ answers: [""] });
    const { said, relay } = await runBridge({ ...acp, events: [received("event-1", "chat-1", "Hey, what's up")] });
    expect(relay.sent).toEqual([]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said.at(-1)).toBe("Cursor gave no answer to @alice.dev, so nothing was sent.");
  });

  it("keeps answering after a send Relay would not take", async () => {
    const acp = await fakeAcpAgent();
    const events = [received("event-1", "chat-1", "one"), received("event-2", "chat-2", "two")];
    const relay = fakeRelay(events);
    relay.failSends();
    const { said } = await runBridge({ ...acp, events, relay });
    expect(said.filter((line) => line.includes("did not reach Relay"))).toHaveLength(2);
  });

  it("answers a message once, however often Relay sends it", async () => {
    const acp = await fakeAcpAgent();
    const event = received("event-1", "chat-1", "Hey, what's up");
    const { relay } = await runBridge({ ...acp, events: [event, event], endings: 1 });
    expect(relay.sent).toHaveLength(1);
    expect((await acp.log()).filter((line) => line.in === "session/prompt")).toHaveLength(1);
  });

  it("declines a tool permission automatically when nobody is at the keyboard", () => {
    const options = [
      { optionId: "yes", name: "Allow", kind: "allow_once" as const },
      { optionId: "no", name: "Reject", kind: "reject_once" as const },
    ];
    expect(autoPermission({ sessionId: "s", toolCall: {} as never, options })).toEqual({
      outcome: { outcome: "selected", optionId: "yes" },
    });
    expect(autoPermission({ sessionId: "s", toolCall: {} as never, options: [] })).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});

describe("one session for each chat", () => {
  it("gives a second chat its own session, and keeps the first chat on its own", async () => {
    const acp = await fakeAcpAgent();
    await runBridge({
      ...acp,
      events: [
        received("event-1", "chat-1", "first"),
        received("event-2", "chat-2", "somewhere else"),
        received("event-3", "chat-1", "again"),
      ],
    });
    const prompts = (await acp.log()).filter((line) => line.in === "session/prompt");
    expect(prompts.map((line) => line.params?.sessionId)).toEqual(["session-1", "session-2", "session-1"]);
  });

  it("takes the chat's session back when the bridge is started again", async () => {
    const acp = await fakeAcpAgent();
    const home = await scratch("sessions-home");
    const context = { env: { RELAY_CONFIG_DIR: home } };
    await runBridge({
      ...acp, events: [received("event-1", "chat-1", "first")],
      sessions: await openAcpSessions({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context),
    });
    await runBridge({
      ...acp, events: [received("event-2", "chat-1", "second")],
      sessions: await openAcpSessions({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context),
    });
    expect(traffic(await acp.log()).filter((line) => line.startsWith("session/") && line !== "session/prompt"))
      .toEqual(["session/new", "session/load"]);
    const load = (await acp.log()).find((line) => line.in === "session/load");
    expect(load?.params).toMatchObject({ sessionId: "session-1", cwd: acp.cwd });
  });

  it("starts a new session, and keeps that one, when the agent has lost the saved one", async () => {
    const acp = await fakeAcpAgent();
    const home = await scratch("sessions-lost");
    const context = { env: { RELAY_CONFIG_DIR: home } };
    const store = await openAcpSessions({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context);
    await store.set("chat-1", "session-nobody-has");
    const { said } = await runBridge({ ...acp, events: [received("event-1", "chat-1", "first")], sessions: store });
    expect(traffic(await acp.log()).filter((line) => line.startsWith("session/") && line !== "session/prompt"))
      .toEqual(["session/load", "session/new"]);
    expect(said).toContain("Cursor no longer has this chat's session. It starts a new one.");
    const kept = await openAcpSessions({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context);
    expect(kept.get("chat-1")).toBe("session-1");
  });

  it("starts a new session when the agent cannot load one at all", async () => {
    const acp = await fakeAcpAgent({ loadSession: false });
    const home = await scratch("sessions-noload");
    const context = { env: { RELAY_CONFIG_DIR: home } };
    const store = await openAcpSessions({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context);
    await store.set("chat-1", "session-saved");
    await runBridge({ ...acp, events: [received("event-1", "chat-1", "first")], sessions: store });
    // A session/load is never even tried when the agent did not advertise it.
    expect(traffic(await acp.log()).filter((line) => line.startsWith("session/") && line !== "session/prompt"))
      .toEqual(["session/new"]);
  });
});

describe("when turns run", () => {
  it("never runs two turns in one chat at once: the newer message replaces the older", async () => {
    const acp = await fakeAcpAgent({ turnMs: 300 });
    const { said, relay } = await runBridge({
      ...acp,
      events: [received("event-1", "chat-1", "wait, actually"), received("event-2", "chat-1", "this instead")],
      endings: 2,
    });
    // A turn never begins in this chat while another one is running: the one
    // running is cancelled first, and only then does the next one start.
    expect(traffic(await acp.log()).filter((line) => line.includes("session/prompt") || line.includes("session/cancel")))
      .toEqual(["session/prompt", "session/cancel", "session/prompt"]);
    expect(said).toContain("A newer message came in, so the answer to @alice.dev was dropped.");
    // Nothing is sent for the turn that was cancelled.
    expect(relay.sent.map((message) => message.key)).toEqual(["acp-bridge-event-2"]);
  });

  it("runs turns in two chats at the same time", async () => {
    const acp = await fakeAcpAgent({ turnMs: 120 });
    const { relay } = await runBridge({
      ...acp,
      events: [received("event-1", "chat-1", "first"), received("event-2", "chat-2", "second")],
      endings: 2,
    });
    // Both prompts are sent before either one answers, which one agent with one
    // session for each chat is what allows.
    expect(traffic(await acp.log()).filter((line) => line === "session/prompt" || line === "out session/update"))
      .toEqual(["session/prompt", "session/prompt", "out session/update", "out session/update"]);
    expect(relay.sent.map((message) => message.key).sort()).toEqual(["acp-bridge-event-1", "acp-bridge-event-2"]);
  });
});

/**
 * The real agent, only when one is on PATH. Skipped everywhere else, so CI does
 * not need cursor-agent, gemini or opencode installed. Set RELAY_ACP_AGENT to
 * the command (for example `opencode`) and RELAY_ACP_ARGS to its ACP words
 * (for example `acp`) to run it.
 */
const realAgent = process.env.RELAY_ACP_AGENT;
describe.skipIf(!realAgent)("the real ACP agent, when one is on PATH", () => {
  it("answers one message end to end", async () => {
    const cwd = await scratch("real-acp");
    const found = execFileSync(process.platform === "win32" ? "where" : "which", [realAgent!], { encoding: "utf8" })
      .split(/\r?\n/u).find(Boolean)!.trim();
    const args = (process.env.RELAY_ACP_ARGS ?? "acp").split(" ").filter(Boolean);
    const acp = await acpCommand(found, args);
    const event = received("event-1", "chat-1", "Reply with the single word: pong.");
    const { relay } = await runBridge({ acp, cwd, events: [event] });
    expect(relay.sent).toHaveLength(1);
  });
});
