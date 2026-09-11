import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bridgeTurn, codexExecArgs, codexPrompt, codexRunner, readCodexJsonl, replyKey, runCodexBridge,
  type CodexRunner,
} from "./codex-bridge.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

/** A `codex` that answers whatever the test asked for, and records its own command line. */
async function fakeCodex(behaviour: { answer?: string; code?: number; threadId?: string }): Promise<{ command: string; cwd: string; calls: () => Promise<string[][]> }> {
  const folder = await mkdtemp(join(tmpdir(), "relay-fake-codex-"));
  folders.push(folder);
  const command = join(folder, "codex");
  const record = join(folder, "calls.jsonl");
  await writeFile(command, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(args) + "\\n");`,
    `const answer = ${JSON.stringify(behaviour.answer ?? "")};`,
    `const threadId = ${JSON.stringify(behaviour.threadId ?? "01a0-thread")};`,
    'process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");',
    "if (answer) {",
    '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: answer } }) + "\\n");',
    '  const at = args.indexOf("--output-last-message");',
    "  if (at >= 0) fs.writeFileSync(args[at + 1], answer + \"\\n\");",
    "}",
    'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
    `process.exit(${behaviour.code ?? 0});`,
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return {
    command, cwd: folder,
    calls: async () => (await readFile(record, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
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
  it("opens a session without a prompt to confirm, and writes the answer to a file", () => {
    expect(codexExecArgs({ prompt: "hello", answerFile: "/tmp/answer.txt" })).toEqual([
      "exec", "--json", "--skip-git-repo-check",
      "--sandbox", "workspace-write",
      "--output-last-message", "/tmp/answer.txt",
      "hello",
    ]);
  });

  it("keeps the chat's context by resuming the session Codex opened for it", () => {
    expect(codexExecArgs({ prompt: "and again", answerFile: "/tmp/answer.txt", threadId: "01a0-thread" })).toEqual([
      "exec", "resume", "01a0-thread", "--json", "--skip-git-repo-check",
      "-c", 'sandbox_mode="workspace-write"',
      "--output-last-message", "/tmp/answer.txt",
      "and again",
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
    expect(calls[0]!.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
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
    expect(calls.map((call) => call.slice(0, 3))).toEqual([
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
