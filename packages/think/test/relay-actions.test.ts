import { encodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StepResult, ToolSet } from "ai";

import {
  RELAY_ACTION_NAMES,
  RelayReplyRefused,
  RelayTurnRequired,
  createRelayTurnSettled,
  relayActions,
  relayTurnFromMessenger,
  relayTurnSettled,
  type RelayActionsAgent,
} from "../src/actions";

// @cloudflare/think loads cloudflare:workers, which exists only in a Worker.
// action() wraps its config; these tests call the config's execute.
vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const PAYMENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";

interface Wired {
  config: {
    description: string;
    timeoutMs?: number;
    idempotencyKey?: (args: { input: unknown; ctx: unknown }) => string;
    inputSchema: { parse(value: unknown): unknown };
    execute(input: unknown, context: { signal?: AbortSignal; toolCallId?: string; requestId?: string }): Promise<unknown>;
  };
}

const ENV = { RELAY_AGENT_TOKEN: "relay-test-token", RELAY_API_ORIGIN: "https://api.example.test" };
const OPTIONS = { env: ENV, ctx: { waitUntil: () => {} } };

function agent(kind = "direct-message"): RelayActionsAgent {
  return {
    getMessengerContext: () => ({
      kind,
      thread: { providerThreadId: encodeRelayThreadId({ chatId: CHAT_ID }) },
      message: { id: `relay:${MESSAGE_ID}`, providerMessageId: MESSAGE_ID },
    }),
  };
}

/** Records each request and answers with the body `respond` picks. */
function relayServer(respond: (url: string, method: string) => Response) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    return respond(url, method);
  }));
  return calls;
}

async function run(name: string, input: unknown = {}): Promise<unknown> {
  const wired = relayActions(agent(), OPTIONS)[name] as unknown as Wired;
  return await wired.config.execute(wired.config.inputSchema.parse(input), {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayActions", () => {
  it("offers every Relay Action in one call", () => {
    expect(Object.keys(relayActions(agent(), OPTIONS)).sort()).toEqual([...RELAY_ACTION_NAMES].sort());
  });

  it("leaves out the Actions the agent disables, and keeps the rest", () => {
    const actions = relayActions(agent(), { ...OPTIONS, disable: ["start_call", "group"] });
    expect(actions.start_call).toBeUndefined();
    expect(actions.group).toBeUndefined();
    expect(Object.keys(actions)).toHaveLength(RELAY_ACTION_NAMES.length - 2);
  });

  it("leaves the agent's own tools to a spread beside them", () => {
    const own = { lookup_order: relayActions(agent(), OPTIONS).stay_silent! };
    expect(Object.keys({ ...relayActions(agent(), OPTIONS), ...own })).toContain("lookup_order");
  });

  it("offers image and voice_memo only when the agent gives its own media models", () => {
    const kinds = (actions: ReturnType<typeof relayActions>) => {
      const schema = (actions.send as unknown as Wired).config.inputSchema;
      return ["image", "voice_memo"].filter((kind) => {
        try {
          schema.parse(kind === "image" ? { kind, prompt: "a cat" } : { kind, text: "hi" });
          return true;
        } catch {
          return false;
        }
      });
    };
    expect(kinds(relayActions(agent(), OPTIONS))).toEqual([]);
    expect(kinds(relayActions(agent(), { ...OPTIONS,
      media: { image: async () => ({ bytes: new Uint8Array(1), contentType: "image/png" }) },
    }))).toEqual(["image"]);
    expect((relayActions(agent(), OPTIONS).send as unknown as Wired).config.description).not.toContain("voice_memo");
  });

  it("reads the turn's Chat and Message from Think's messenger context", async () => {
    const calls = relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    await run("send", { kind: "text", text: "hi", reply: true });
    expect(calls[0]!.url).toBe(`https://api.example.test/v1/chats/${CHAT_ID}/messages`);
    expect(JSON.parse(calls[0]!.body!).message).toMatchObject({
      idempotency_key: `relay-agent:${MESSAGE_ID}:1`,
      reply_to: { message_id: MESSAGE_ID, part_index: 0 },
    });
  });

  it("react reacts to the turn's Message", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("react", { type: "love" })).resolves.toEqual({ status: "reacted", type: "love" });
    expect(calls[0]!.url).toBe(`https://api.example.test/v1/messages/${MESSAGE_ID}/reactions`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ operation: "add", type: "love" });
  });

  it("request_location asks this Chat's person to share", async () => {
    const calls = relayServer(() => new Response(null, { status: 204 }));
    await expect(run("request_location")).resolves.toEqual({ status: "requested" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/location`);
  });

  it("read_location reads this Chat's shares", async () => {
    const calls = relayServer(() => Response.json({ data: { type: "FeatureCollection", features: [] } }));
    await expect(run("read_location")).resolves.toEqual({ status: "not_sharing" });
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/location`);
  });

  it("start_call refuses a group without ringing anyone", async () => {
    const calls = relayServer(() => Response.json({ id: CHAT_ID, is_group: true, handles: [] }));
    await expect(run("start_call")).resolves.toMatchObject({ status: "not_called" });
    expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
      `GET https://api.example.test/v1/chats/${CHAT_ID}`,
    ]);
  });

  it("find_agents looks agents up by task", async () => {
    const calls = relayServer(() => Response.json({ contacts: [] }));
    await expect(run("find_agents", { task: "plan a trip" })).resolves.toEqual({ status: "found", contacts: [] });
    expect(calls[0]!.url).toContain("/v1/contacts/");
    expect(decodeURIComponent(calls[0]!.url + (calls[0]!.body ?? ""))).toContain("plan a trip");
  });

  it("payment_request reads a request by its id", async () => {
    const calls = relayServer(() => Response.json({ error: { message: "No such payment request" } }, { status: 404 }));
    await expect(run("payment_request", { do: "status", payment_request_id: PAYMENT_ID })).resolves.toMatchObject({
      status: "not_found",
    });
    expect(calls[0]!.url).toContain(`/v1/payment_requests/${PAYMENT_ID}`);
  });

  it("group refuses to change a one-to-one Chat", async () => {
    const calls = relayServer(() => Response.json({ id: CHAT_ID, is_group: false, handles: [] }));
    await expect(run("group", { do: "rename", name: "Trip" })).resolves.toMatchObject({ status: "not_done" });
    expect(calls).toHaveLength(1);
  });

  it("share_contact_card shares the agent's card into this Chat", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("share_contact_card")).resolves.toEqual({ status: "done" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/`);
  });

  it("stay_silent sends nothing", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("stay_silent")).resolves.toEqual({ status: "silent" });
    expect(calls).toHaveLength(0);
  });

  it("wires Think's ledger: each Action's idempotency key, and send never times out", () => {
    const actions = relayActions(agent(), OPTIONS);
    const keys = Object.fromEntries(Object.entries(actions).map(([name, wired]) => {
      const key = (wired as unknown as Wired).config.idempotencyKey;
      return [name, key ? key({ input: {}, ctx: { requestId: "attempt-ledger", toolCallId: "call-1" } }) : null];
    }));
    expect(keys).toEqual({
      // One ledger row per send or react call, so a turn may make several.
      send: `message:${MESSAGE_ID}:1`,
      react: `reaction:${MESSAGE_ID}:1`,
      stay_silent: `message:${MESSAGE_ID}`,
      request_location: `location_request:${MESSAGE_ID}`,
      start_call: `call:${MESSAGE_ID}`,
      group: `group:${MESSAGE_ID}`,
      share_contact_card: `contact_card:${MESSAGE_ID}`,
      read_location: null,
      find_agents: null,
      payment_request: null,
    });
    // Think 0.17 starts a framework timeout only when timeoutMs > 0; the voice
    // memo's send must never lose its ledger row to one.
    expect((actions.send as unknown as Wired).config.timeoutMs).toBe(0);
  });

  it("numbers each send by its place in the turn, in one step or across steps", async () => {
    const calls = relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    const wired = relayActions(agent(), { ...OPTIONS, compose: async () => {} }).send as unknown as Wired;
    const ctx = (toolCallId: string) => ({ requestId: "attempt-steps", toolCallId });
    // Two sends in one step run in parallel; a third comes in the next step.
    const keys = [wired.config.idempotencyKey!({ input: {}, ctx: ctx("a") }), wired.config.idempotencyKey!({ input: {}, ctx: ctx("b") })];
    await Promise.all([
      wired.config.execute({ kind: "text", text: "on my way" }, ctx("a")),
      wired.config.execute({ kind: "text", text: "10 min" }, ctx("b")),
    ]);
    keys.push(wired.config.idempotencyKey!({ input: {}, ctx: ctx("c") }));
    await wired.config.execute({ kind: "text", text: "here" }, ctx("c"));
    expect(keys).toEqual([`message:${MESSAGE_ID}:1`, `message:${MESSAGE_ID}:2`, `message:${MESSAGE_ID}:3`]);
    expect(calls.map((call) => JSON.parse(call.body!).message.idempotency_key)).toEqual([
      `relay-agent:${MESSAGE_ID}:1`, `relay-agent:${MESSAGE_ID}:2`, `relay-agent:${MESSAGE_ID}:3`,
    ]);
  });

  it("does not send twice when Think runs the turn again for the same event with new tool call ids", async () => {
    const calls = relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    const actions = relayActions(agent(), { ...OPTIONS, compose: async () => {} });
    // Think's ledger as its Actions page describes it: rows keyed
    // action:<name>:<key>; a key already settled returns its stored result
    // without running execute again.
    const ledger = new Map<string, unknown>();
    const runLedgered = async (name: string, input: unknown, ctx: { requestId: string; toolCallId: string }) => {
      const config = (actions[name] as unknown as Wired).config;
      const row = `action:${name}:${config.idempotencyKey!({ input, ctx })}`;
      if (ledger.has(row)) return ledger.get(row);
      const result = await config.execute(input, ctx);
      ledger.set(row, result);
      return result;
    };
    await runLedgered("send", { kind: "text", text: "on my way" }, { requestId: "attempt-1", toolCallId: "x1" });
    await runLedgered("react", { type: "love" }, { requestId: "attempt-1", toolCallId: "x2" });
    // The isolate restarts mid-turn; Think recovers and runs the turn again.
    await runLedgered("send", { kind: "text", text: "on my way!" }, { requestId: "attempt-2", toolCallId: "y1" });
    await runLedgered("react", { type: "love" }, { requestId: "attempt-2", toolCallId: "y2" });
    await runLedgered("send", { kind: "text", text: "10 min" }, { requestId: "attempt-2", toolCallId: "y3" });
    expect([...ledger.keys()]).toEqual([
      `action:send:message:${MESSAGE_ID}:1`,
      `action:react:reaction:${MESSAGE_ID}:1`,
      `action:send:message:${MESSAGE_ID}:2`,
    ]);
    const sends = calls.filter((call) => call.url.endsWith("/messages"));
    expect(sends.map((call) => JSON.parse(call.body!).message.idempotency_key)).toEqual([
      `relay-agent:${MESSAGE_ID}:1`, `relay-agent:${MESSAGE_ID}:2`,
    ]);
    expect(calls.filter((call) => call.url.includes("/reactions"))).toHaveLength(1);
  });

  it("removes Google Search citation markers from send's words when the agent searches", async () => {
    const calls = relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    const wired = relayActions(agent(), { ...OPTIONS, webSearch: true }).send as unknown as Wired;
    await wired.config.execute(wired.config.inputSchema.parse({ kind: "text", text: "Fares fell [1.2] in May [1]." }), {});
    expect(JSON.parse(calls[0]!.body!).message.parts).toEqual([{ type: "text", value: "Fares fell in May [1]." }]);
  });

  it("lets the agent extend an Action's description", () => {
    const actions = relayActions(agent(), {
      ...OPTIONS,
      describe: (name, description) => name === "start_call" ? `${description} Or set a follow-up.` : description,
    });
    expect((actions.start_call as unknown as Wired).config.description).toMatch(/for later\. .* Or set a follow-up\.$/su);
    expect((actions.react as unknown as Wired).config.description).not.toContain("follow-up");
  });

  it("hands a voice memo's unfinished send to the agent's ctx.waitUntil", async () => {
    const handed: Promise<unknown>[] = [];
    relayServer((url) => url.endsWith("/v1/attachments")
      ? Response.json({
        attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
        upload_url: "https://upload.example/voice",
        download_url: "https://api.example.test/attachment",
        http_method: "PUT",
        expires_at: "2026-09-01T12:00:00Z",
        required_headers: { "content-type": "audio/x-wav" },
      })
      : Response.json({ voice_memo: { id: "sent" } }));
    const wired = relayActions(agent(), {
      env: ENV,
      ctx: { waitUntil: (promise) => handed.push(promise) },
      compose: async () => undefined,
      media: { voiceMemo: async () => ({ bytes: new Uint8Array(48), contentType: "audio/x-wav", durationMs: 1 }) },
    }).send as unknown as Wired;
    await expect(wired.config.execute({ kind: "voice_memo", text: "hi" }, {})).resolves.toMatchObject({
      status: "terminal_ambiguous",
    });
    expect(handed).toHaveLength(1);
    await Promise.all(handed);
  });
});

describe("the turn outside a messenger", () => {
  it("asks for a turn option, by name, when Think has no messenger context", async () => {
    const wired = relayActions({ getMessengerContext: () => undefined }, OPTIONS).send as unknown as Wired;
    await expect(wired.config.execute({ kind: "text", text: "hi" }, {})).rejects.toThrow(RelayTurnRequired);
    await expect(wired.config.execute({ kind: "text", text: "hi" }, {})).rejects.toThrow("`turn` option");
  });

  it("takes the agent's own turn for an event turn, which answers no Message", async () => {
    relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    const wired = relayActions({ getMessengerContext: () => undefined }, {
      ...OPTIONS,
      turn: () => ({ chatId: CHAT_ID, eventId: "call-event" }),
    }).send as unknown as Wired;
    await expect(wired.config.execute({ kind: "text", text: "hi", reply: true }, {})).rejects.toThrow(RelayReplyRefused);
    await expect(wired.config.execute({ kind: "text", text: "hi" }, {})).resolves.toMatchObject({ status: "sent" });
  });

  it("quote-replies only on a person's Message, not on a tap or a delivery event", () => {
    const context = (kind: string) => ({
      kind,
      thread: { providerThreadId: encodeRelayThreadId({ chatId: CHAT_ID }) },
      message: { providerMessageId: MESSAGE_ID },
    });
    expect(relayTurnFromMessenger(context("direct-message")).replyTo).toEqual({ messageId: MESSAGE_ID, partIndex: 0 });
    expect(relayTurnFromMessenger(context("action")).replyTo).toBeUndefined();
    expect(relayTurnFromMessenger(context("delivery-event")).replyTo).toBeUndefined();
  });
});

describe("createRelayTurnSettled", () => {
  const step = (toolName: string) => ({
    steps: [{ toolCalls: [{ toolName, toolCallId: "1" }], toolResults: [] }] as unknown as StepResult<ToolSet>[],
  });

  it("ends the turn on the agent's own visible send, and goes on after its other tools", () => {
    const settled = createRelayTurnSettled({ visibleSends: ["send_video"] });
    expect(settled(step("send_video"))).toBe(true);
    expect(settled(step("lookup_order"))).toBe(false);
    expect(relayTurnSettled(step("send_video"))).toBe(false);
  });

  it("goes on after a send or reaction, and ends on no tool, stay_silent, or a ringing call", () => {
    const called = (toolName: string, output?: unknown) => ({
      steps: [{
        toolCalls: [{ toolName, toolCallId: "1" }],
        toolResults: output === undefined ? [] : [{ toolCallId: "1", toolName, output }],
      }] as unknown as StepResult<ToolSet>[],
    });
    expect(relayTurnSettled(called("send", { status: "sent", kind: "text" }))).toBe(false);
    expect(relayTurnSettled(called("react", { status: "reacted", type: "love" }))).toBe(false);
    expect(relayTurnSettled(called("stay_silent", { status: "silent" }))).toBe(true);
    expect(relayTurnSettled(called("start_call", { status: "ringing", call_id: "c" }))).toBe(true);
    expect(relayTurnSettled(called("start_call", { status: "not_called", reason: "busy" }))).toBe(false);
    expect(relayTurnSettled({
      steps: [{ toolCalls: [], toolResults: [] }] as unknown as StepResult<ToolSet>[],
    })).toBe(true);
  });
});
