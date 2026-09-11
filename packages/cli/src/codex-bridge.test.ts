import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bridgeTurn, codexCommand, codexExecArgs, codexPrompt, codexRunner, readCodexJsonl, replyKey, runCodexBridge,
  type CodexCommand, type CodexRunner,
} from "./codex-bridge.js";
import { platformCommand } from "./spawn-command.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

interface FakeCall {
  args: string[];
  /** What Codex was given on stdin, where `-` stands on the command line. */
  prompt: string;
}

/**
 * A `codex` that answers whatever the test asked for, and writes down its own
 * command line and prompt. It is a Node script run by this very Node, so
 * Windows runs it exactly as macOS and Linux do: an extensionless file with a
 * `#!` line is not a program there, and npm installs the real Codex as a
 * `.cmd` shim, which is what the bridge now starts (spawn-command.ts).
 */
async function fakeCodex(behaviour: { answer?: string; code?: number; threadId?: string }): Promise<{ command: CodexCommand; cwd: string; calls: () => Promise<FakeCall[]> }> {
  const folder = await mkdtemp(join(tmpdir(), "relay-fake-codex-"));
  folders.push(folder);
  const script = join(folder, "codex.cjs");
  const record = join(folder, "calls.jsonl");
  await writeFile(script, [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    `const answer = ${JSON.stringify(behaviour.answer ?? "")};`,
    `const threadId = ${JSON.stringify(behaviour.threadId ?? "01a0-thread")};`,
    'let prompt = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { prompt += chunk; });',
    'process.stdin.on("end", () => {',
    `  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, prompt }) + "\\n");`,
    '  fs.writeSync(1, JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");',
    "  if (answer) {",
    '    fs.writeSync(1, JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } }) + "\\n");',
    '    const at = args.indexOf("--output-last-message");',
    "    if (at >= 0) fs.writeFileSync(args[at + 1], answer + \"\\n\");",
    "  }",
    '  fs.writeSync(1, JSON.stringify({ type: "turn.completed" }) + "\\n");',
    `  process.exitCode = ${behaviour.code ?? 0};`,
    "});",
  ].join("\n"), "utf8");
  return {
    command: { command: process.execPath, args: [script] }, cwd: folder,
    calls: async () => (await readFile(record, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeCall),
  };
}

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
function fakeRelay(events: readonly RelayWebhookEvent[], deliverAtOnce = false) {
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
        // Relay's own connection hands events over one at a time. `deliverAtOnce`
        // hands them all over at once instead, so the test reads the bridge's
        // own ordering rather than the one it is given.
        if (deliverAtOnce) {
          await Promise.all(events.map((event, index) => options.onEvent(event, { sequence: String(index + 1) })));
          return;
        }
        for (const [index, event] of events.entries()) await options.onEvent(event, { sequence: String(index + 1) });
      },
    },
  } as unknown as Pick<Relay, "chats" | "websocket">;
  return { client, typing, sent, failSends: () => { sendFails = true; } };
}

describe("the command line the bridge runs", () => {
  it("opens a session without a prompt to confirm, takes the prompt on stdin, and writes the answer to a file", () => {
    expect(codexExecArgs({ answerFile: "/tmp/answer.txt" })).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--sandbox", "workspace-write",
      "--output-last-message", "/tmp/answer.txt",
      "-",
    ]);
  });

  it("keeps the chat's context by resuming the session Codex opened for it", () => {
    expect(codexExecArgs({ answerFile: "/tmp/answer.txt", threadId: "01a0-thread" })).toEqual([
      "exec", "resume", "01a0-thread", "--json", "--skip-git-repo-check",
      "-c", 'sandbox_mode="workspace-write"',
      "--output-last-message", "/tmp/answer.txt",
      "-",
    ]);
  });

  it("reads the session id and the last answer out of the printed events", () => {
    expect(readCodexJsonl([
      '{"type":"thread.started","thread_id":"01a0-thread"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"All good."}}',
      "not json",
      '{"type":"turn.completed"}',
    ].join("\n"))).toEqual({ answer: "All good.", threadId: "01a0-thread" });
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
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-path-"));
    folders.push(folder);
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
    expect(platformCommand("C:\\bin\\codex.cmd", ["exec", "-"], "win32")).toEqual({
      file: '^"C:\\bin\\codex.cmd^"', args: ['^"exec^"', '^"-^"'], shell: true,
    });
    expect(platformCommand("C:\\Program Files\\nodejs\\node.exe", ["codex.cjs"], "win32")).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe", args: ["codex.cjs"], shell: false,
    });
    expect(platformCommand("/usr/local/bin/codex", ["exec"], "darwin")).toEqual({
      file: "/usr/local/bin/codex", args: ["exec"], shell: false,
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

describe("answering a message", () => {
  it("runs Codex, sends what it answered, and shows typing while it works", async () => {
    const codex = await fakeCodex({ answer: "Not much. Your README says this is a test project." });
    const relay = fakeRelay([received("event-1", "chat-1", "Hey, what's up")]);
    const said: string[] = [];
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: (line) => said.push(line),
    });
    expect(relay.sent).toEqual([{
      chatId: "chat-1",
      text: "Not much. Your README says this is a test project.",
      key: "codex-bridge-event-1",
    }]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said).toEqual(["@alice.dev  Hey, what's up", "Sent the answer to @alice.dev."]);
    const calls = await codex.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
    expect(calls[0]!.args.at(-1)).toBe("-");
    expect(calls[0]!.prompt).toBe(codexPrompt("alice.dev", "Hey, what's up"));
  });

  it("keeps the chat's context, and starts a new session for a new chat", async () => {
    const codex = await fakeCodex({ answer: "Yes.", threadId: "01a0-thread" });
    const relay = fakeRelay([
      received("event-1", "chat-1", "first"),
      received("event-2", "chat-1", "second"),
      received("event-3", "chat-2", "somewhere else"),
    ]);
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: () => undefined,
    });
    const calls = await codex.calls();
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["exec", "--json", "--skip-git-repo-check"],
      ["exec", "resume", "01a0-thread"],
      ["exec", "--json", "--skip-git-repo-check"],
    ]);
    expect(relay.sent.map((message) => message.key)).toEqual([
      "codex-bridge-event-1", "codex-bridge-event-2", "codex-bridge-event-3",
    ]);
  });

  it("sends nothing when Codex stops with an error, and says so once", async () => {
    const codex = await fakeCodex({ answer: "half an answer", code: 1 });
    const relay = fakeRelay([received("event-1", "chat-1", "Hey, what's up")]);
    const said: string[] = [];
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: (line) => said.push(line),
    });
    expect(relay.sent).toEqual([]);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1"]);
    expect(said).toEqual(["@alice.dev  Hey, what's up", "Codex gave no answer to @alice.dev, so nothing was sent."]);
  });

  it("sends nothing when Codex answers with nothing", async () => {
    const codex = await fakeCodex({ answer: "" });
    const relay = fakeRelay([received("event-1", "chat-1", "Hey, what's up")]);
    const said: string[] = [];
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: (line) => said.push(line),
    });
    expect(relay.sent).toEqual([]);
    expect(said.at(-1)).toBe("Codex gave no answer to @alice.dev, so nothing was sent.");
  });

  it("keeps answering after a send Relay would not take", async () => {
    const codex = await fakeCodex({ answer: "Here you go." });
    const relay = fakeRelay([received("event-1", "chat-1", "one"), received("event-2", "chat-1", "two")]);
    relay.failSends();
    const said: string[] = [];
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: (line) => said.push(line),
    });
    expect(said.filter((line) => line.includes("did not reach Relay"))).toHaveLength(2);
    expect(relay.typing).toEqual(["start chat-1", "stop chat-1", "start chat-1", "stop chat-1"]);
  });

  it.each([
    ["one chat", ["chat-1", "chat-1"]],
    ["two chats in one folder", ["chat-1", "chat-2"]],
  ])("runs Codex once at a time for %s, in the order the messages arrived", async (_name, chats) => {
    const order: string[] = [];
    let running = 0;
    const run: CodexRunner = async (codexRun) => {
      const which = codexRun.prompt.includes("first") ? "first" : "second";
      running += 1;
      order.push(`start ${which} running=${running}`);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      running -= 1;
      order.push(`end ${which}`);
      return { code: 0, answer: `answered the ${which}`, threadId: `thread-${which}` };
    };
    const relay = fakeRelay([
      received("event-1", chats[0]!, "the first message"),
      received("event-2", chats[1]!, "the second message"),
    ], true);
    await runCodexBridge({
      client: relay.client, run, signal: new AbortController().signal, say: () => undefined,
    });
    expect(order).toEqual([
      "start first running=1", "end first",
      "start second running=1", "end second",
    ]);
    expect(relay.sent.map((message) => message.text)).toEqual(["answered the first", "answered the second"]);
  });

  it("answers a message once, however often Relay sends it", async () => {
    const codex = await fakeCodex({ answer: "Once." });
    const event = received("event-1", "chat-1", "Hey, what's up");
    const relay = fakeRelay([event, event]);
    await runCodexBridge({
      client: relay.client, run: codexRunner(codex.command, codex.cwd),
      signal: new AbortController().signal, say: () => undefined,
    });
    expect(relay.sent).toHaveLength(1);
    expect(await codex.calls()).toHaveLength(1);
  });
});
