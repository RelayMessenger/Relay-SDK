import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bridgeTurn, codexCommand, codexPrompt, isFinalMessage, replyKey, runCodexBridge,
  type CodexCommand,
} from "./codex-bridge.js";
import { openCodexThreads, type CodexThreadStore } from "./codex-threads.js";
import { platformCommand } from "./spawn-command.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

const scratch = async (name: string): Promise<string> => {
  const folder = await mkdtemp(join(tmpdir(), `relay-${name}-`));
  folders.push(folder);
  return folder;
};

/** One agent message the fake app-server answers with. */
interface FakeAnswer { text: string; phase?: string }

/** One line the fake app-server wrote down: a message in, or a notification out. */
interface FakeLine {
  in?: string;
  out?: string;
  params?: Record<string, unknown>;
  argv?: string[];
}

/**
 * A `codex` whose `app-server` is the script beside this test. It is started
 * exactly as the real one is, through `spawnCommand`, so this covers the
 * Windows line too: an extensionless script is not a program on Windows, and
 * this one is run by this very Node.
 */
const fakeAppServer = async (settings: {
  answers?: FakeAnswer[][];
  turnMs?: number;
  resumable?: string[];
} = {}): Promise<{ codex: CodexCommand; cwd: string; log(): Promise<FakeLine[]> }> => {
  const folder = await scratch("fake-app-server");
  const record = join(folder, "messages.jsonl");
  const settingsPath = join(folder, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ record, ...settings }), "utf8");
  const script = fileURLToPath(new URL("./codex-app-server.fake.cjs", import.meta.url));
  return {
    codex: { command: process.execPath, args: [script, settingsPath] },
    cwd: folder,
    log: async () => {
      const written = await readFile(record, "utf8").catch(() => "");
      return written.split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLine);
    },
  };
};

/** What the fake app-server was asked to do, and what it announced, in order. */
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
      // Relay's own connection hands one event over at a time and waits for
      // each to be taken before the next (packages/sdk/src/websocket.ts).
      run: async (options: { onEvent(event: RelayWebhookEvent, context: { sequence: string }): Promise<void> }) => {
        for (const [index, event] of events.entries()) await options.onEvent(event, { sequence: String(index + 1) });
      },
    },
  } as unknown as Pick<Relay, "chats" | "websocket">;
  return { client, typing, sent, failSends: () => { sendFails = true; } };
}

/** Every way one message can end on the terminal. */
const ENDED = /Sent the answer|gave no answer|did not reach Relay|was dropped/u;

/**
 * The bridge hands a message to Codex and lets the turn finish behind it, so a
 * test waits for the messages to end rather than for the connection to close.
 */
const untilEnded = async (said: readonly string[], count: number): Promise<void> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (said.filter((line) => ENDED.test(line)).length >= count) return;
    if (Date.now() > deadline) throw new Error(`Only these messages ended: ${said.join(" | ")}`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
};

/** The thread ids, kept in memory, for the tests that are not about the file. */
const memoryThreads = (): CodexThreadStore => {
  const threads = new Map<string, string>();
  return {
    get: (chatId) => threads.get(chatId),
    set: async (chatId, threadId) => { threads.set(chatId, threadId); },
  };
};

/** One run of the bridge over one list of events, stopped once they have ended. */
const runBridge = async (input: {
  codex: CodexCommand;
  cwd: string;
  events: readonly RelayWebhookEvent[];
  threads?: CodexThreadStore;
  endings?: number;
  relay?: ReturnType<typeof fakeRelay>;
}): Promise<{ said: string[]; relay: ReturnType<typeof fakeRelay> }> => {
  const relay = input.relay ?? fakeRelay(input.events);
  const said: string[] = [];
  const control = new AbortController();
  try {
    await runCodexBridge({
      client: relay.client, codex: input.codex, cwd: input.cwd,
      threads: input.threads ?? memoryThreads(),
      signal: control.signal, say: (line) => said.push(line),
    });
    await untilEnded(said, input.endings ?? input.events.length);
  } finally { control.abort(); }
  return { said, relay };
};

describe("the app-server the bridge starts", () => {
  it("says hello the way the protocol asks, before it opens anything", async () => {
    const codex = await fakeAppServer();
    await runBridge({ ...codex, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const log = await codex.log();
    expect(traffic(log).slice(0, 4)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // The sub-command is the last word on the line, after whatever runs the
    // stand-in: `<codex> app-server`.
    expect(log[0]!.argv).toEqual([expect.stringContaining("settings.json"), "app-server"]);
    expect(log[0]!.params).toEqual({ clientInfo: { name: "relaymessenger", title: "Relay", version: expect.any(String) } });
  });

  it("opens a thread that may write in the folder and asks nobody anything", async () => {
    const codex = await fakeAppServer();
    await runBridge({ ...codex, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const start = (await codex.log()).find((line) => line.in === "thread/start");
    expect(start?.params).toEqual({ cwd: codex.cwd, sandbox: "workspace-write", approvalPolicy: "never" });
  });

  it("sends the message as the turn's text input, and never on a command line", async () => {
    const codex = await fakeAppServer();
    await runBridge({ ...codex, events: [received("event-1", "chat-1", "Hey, what's up")] });
    const turn = (await codex.log()).find((line) => line.in === "turn/start");
    expect(turn?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: codexPrompt("alice.dev", "Hey, what's up") }],
    });
  });

  it("tells Codex the answer travels back on its own", () => {
    expect(codexPrompt("alice.dev", "Hey, what's up")).toContain("@alice.dev sent you this message on Relay:");
    expect(codexPrompt("alice.dev", "Hey, what's up")).toContain("do not send it yourself");
  });

  it("takes the message that arrived as the key, so one message is answered once", () => {
    expect(replyKey("0199e0d0-0000-7000-8000-000000000001")).toBe("codex-bridge-0199e0d0-0000-7000-8000-000000000001");
  });
});

describe("the codex the bridge starts", () => {
  it("takes the Windows shim npm installs, because Windows has no file called codex", async () => {
    const folder = await scratch("codex-path");
    await writeFile(join(folder, "codex.cmd"), "@echo off\r\n", "utf8");
    expect(await codexCommand("codex", { PATH: folder }, "win32")).toEqual({ command: join(folder, "codex.cmd") });
  });

  it("leaves a Windows name the shell can find when nothing is on PATH", async () => {
    expect(await codexCommand("codex", { PATH: "" }, "win32")).toEqual({ command: "codex.cmd" });
  });

  it("keeps the file connect already found", async () => {
    const found = join(tmpdir(), "bin", "codex");
    expect(await codexCommand(found, { PATH: "" }, "darwin")).toEqual({ command: found });
  });

  it("runs a Windows shim through the shell, and a program itself", () => {
    expect(platformCommand("C:\\bin\\codex.cmd", ["app-server"], "win32")).toEqual({
      file: '^"C:\\bin\\codex.cmd^"', args: ['^"app-server^"'], shell: true,
    });
    expect(platformCommand("C:\\Program Files\\nodejs\\node.exe", ["fake.cjs", "app-server"], "win32")).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe", args: ["fake.cjs", "app-server"], shell: false,
    });
    expect(platformCommand("/usr/local/bin/codex", ["app-server"], "darwin")).toEqual({
      file: "/usr/local/bin/codex", args: ["app-server"], shell: false,
    });
  });
});

describe("which messages the bridge answers", () => {
  it("answers an inbound message that has text", () => {
    expect(bridgeTurn(received("event-1", "chat-1", "Hey, what's up"))).toEqual({
      eventId: "event-1", chatId: "chat-1", sender: "alice.dev", text: "Hey, what's up",
    });
  });

  it.each([
    ["its own message coming back", { event_type: "message.sent" }],
    ["an outbound message", { data: { chat: { id: "chat-1" }, direction: "outbound", sender_handle: { handle: "alice.dev" }, parts: [{ type: "text", value: "hi" }] } }],
    ["a message with no text", { data: { chat: { id: "chat-1" }, direction: "inbound", sender_handle: { handle: "alice.dev" }, parts: [] } }],
  ])("leaves %s alone", (_name, override) => {
    expect(bridgeTurn({ ...received("event-1", "chat-1", "hi"), ...override } as RelayWebhookEvent)).toBeUndefined();
  });
});

describe("what the bridge sends back", () => {
  it("sends the answer Codex ended the turn with, and shows typing while it works", async () => {
    const codex = await fakeAppServer({ answers: [[{ text: "Not much. Your README says this is a test project.", phase: "final_answer" }]] });
    const { said, relay } = await runBridge({ ...codex, events: [received("event-1", "chat-1", "Hey, what's up")] });
    expect(relay.sent).toEqual([{
      chatId: "chat-1",
      text: "Not much. Your README says this is a test project.",
      key: "codex-bridge-event-1",
    }]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said).toEqual(["@alice.dev  Hey, what's up", "Sent the answer to @alice.dev."]);
  });

  it("sends the final answer, not what Codex said on the way to it", async () => {
    const codex = await fakeAppServer({
      answers: [[{ text: "Let me look.", phase: "commentary" }, { text: "It is a test project.", phase: "final_answer" }]],
    });
    const { relay } = await runBridge({ ...codex, events: [received("event-1", "chat-1", "what is this")] });
    expect(relay.sent.map((message) => message.text)).toEqual(["It is a test project."]);
  });

  it("counts a message with no phase as the answer, because Codex does not always send one", () => {
    expect([undefined, null, "final_answer", "commentary"].map(isFinalMessage)).toEqual([true, true, true, false]);
  });

  it("sends nothing when Codex answers with nothing, and says so", async () => {
    const codex = await fakeAppServer({ answers: [[]] });
    const { said, relay } = await runBridge({ ...codex, events: [received("event-1", "chat-1", "Hey, what's up")] });
    expect(relay.sent).toEqual([]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said.at(-1)).toBe("Codex gave no answer to @alice.dev, so nothing was sent.");
  });

  it("keeps answering after a send Relay would not take", async () => {
    const codex = await fakeAppServer();
    const events = [received("event-1", "chat-1", "one"), received("event-2", "chat-2", "two")];
    const relay = fakeRelay(events);
    relay.failSends();
    const { said } = await runBridge({ ...codex, events, relay });
    expect(said.filter((line) => line.includes("did not reach Relay"))).toHaveLength(2);
  });

  it("answers a message once, however often Relay sends it", async () => {
    const codex = await fakeAppServer();
    const event = received("event-1", "chat-1", "Hey, what's up");
    const { relay } = await runBridge({ ...codex, events: [event, event], endings: 1 });
    expect(relay.sent).toHaveLength(1);
    expect((await codex.log()).filter((line) => line.in === "turn/start")).toHaveLength(1);
  });
});

describe("one thread for each chat", () => {
  it("gives a second chat its own thread, and keeps the first chat on its own", async () => {
    const codex = await fakeAppServer();
    await runBridge({
      ...codex,
      events: [
        received("event-1", "chat-1", "first"),
        received("event-2", "chat-2", "somewhere else"),
        received("event-3", "chat-1", "again"),
      ],
    });
    const starts = (await codex.log()).filter((line) => line.in === "turn/start");
    expect(starts.map((line) => line.params?.threadId)).toEqual(["thread-1", "thread-2", "thread-1"]);
  });

  it("takes the chat's thread back when the bridge is started again", async () => {
    const codex = await fakeAppServer();
    const home = await scratch("threads-home");
    const context = { env: { RELAY_CONFIG_DIR: home } };
    await runBridge({
      ...codex, events: [received("event-1", "chat-1", "first")],
      threads: await openCodexThreads({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context),
    });
    await runBridge({
      ...codex, events: [received("event-2", "chat-1", "second")],
      threads: await openCodexThreads({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context),
    });
    expect(traffic(await codex.log()).filter((line) => line.startsWith("thread/")))
      .toEqual(["thread/start", "thread/resume"]);
    const resume = (await codex.log()).find((line) => line.in === "thread/resume");
    expect(resume?.params).toEqual({
      threadId: "thread-1", cwd: codex.cwd, sandbox: "workspace-write", approvalPolicy: "never",
    });
  });

  it("starts a new thread, and keeps that one, when Codex has lost the saved one", async () => {
    const codex = await fakeAppServer();
    const home = await scratch("threads-lost");
    const context = { env: { RELAY_CONFIG_DIR: home } };
    const store = await openCodexThreads({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context);
    await store.set("chat-1", "thread-nobody-has");
    const { said } = await runBridge({ ...codex, events: [received("event-1", "chat-1", "first")], threads: store });
    expect(traffic(await codex.log()).filter((line) => line.startsWith("thread/")))
      .toEqual(["thread/resume", "thread/start"]);
    expect(said).toContain("Codex no longer has this chat's thread. It starts a new one.");
    const kept = await openCodexThreads({ apiURL: "https://api.relayapp.im", handle: "agent.dev" }, context);
    expect(kept.get("chat-1")).toBe("thread-1");
  });
});

describe("when turns run", () => {
  it("never runs two turns in one chat at once: the newer message replaces the older", async () => {
    const codex = await fakeAppServer({ turnMs: 300 });
    const { said, relay } = await runBridge({
      ...codex,
      events: [received("event-1", "chat-1", "wait, actually"), received("event-2", "chat-1", "this instead")],
      endings: 2,
    });
    // A turn never begins in this chat while another one is running: the one
    // running is stopped first, and only then does the next one start.
    expect(traffic(await codex.log()).filter((line) => line.includes("turn/")))
      .toEqual(["turn/start", "turn/interrupt", "out turn/completed", "turn/start", "out turn/completed"]);
    expect(said).toContain("A newer message came in, so the answer to @alice.dev was dropped.");
    // Nothing is sent for the turn that was stopped.
    expect(relay.sent.map((message) => message.key)).toEqual(["codex-bridge-event-2"]);
  });

  it("runs turns in two chats at the same time", async () => {
    const codex = await fakeAppServer({ turnMs: 120 });
    const { relay } = await runBridge({
      ...codex,
      events: [received("event-1", "chat-1", "first"), received("event-2", "chat-2", "second")],
      endings: 2,
    });
    // Both turns are running before either one ends, which one process with one
    // thread for each chat is what allows.
    expect(traffic(await codex.log()).filter((line) => line.endsWith("turn/start") || line.endsWith("turn/completed")))
      .toEqual(["turn/start", "turn/start", "out turn/completed", "out turn/completed"]);
    expect(relay.sent.map((message) => message.key)).toEqual(["codex-bridge-event-1", "codex-bridge-event-2"]);
  });
});
