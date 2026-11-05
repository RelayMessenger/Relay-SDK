import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { APPROVAL_REPLY_PREFIX, OwnerApprovals, type ApprovalClient } from "../src/approvals.js";
import { RELAY_AUTHORIZER, registerRelayAuthorizer, relayAuthorizer, type PermissionAsk } from "../src/session-approvals.js";
import { SessionChannel } from "../src/session.js";
import native from "../src/native.js";

/** Relay as the Agent Token sees it: one owner, and every card and reply written down. */
const wire = vi.hoisted(() => ({
  receive: undefined as undefined | ((event: RelayWebhookEvent) => Promise<void>),
  created: [] as { to: string[]; parts: unknown[] }[],
}));
vi.mock("@relaymessenger/sdk", async (original) => ({
  ...await original<typeof import("@relaymessenger/sdk")>(),
  default: class {
    me = { retrieve: async () => ({ handle: "iris.agent", owner_people: [{ handle: "ada" }] }) };
    chats = {
      create: async (body: { to: string[]; message: { parts: unknown[] } }) => {
        wire.created.push({ to: body.to, parts: body.message.parts });
        return { chat: { id: `chat-with-${body.to[0]}`, message: { id: `card-${wire.created.length}` } } };
      },
      messages: { send: vi.fn().mockResolvedValue({}) }, startTyping: vi.fn(), stopTyping: vi.fn(),
    };
    websocket = {
      run: (options: { signal: AbortSignal; onEvent: (event: RelayWebhookEvent) => Promise<void> }) => {
        wire.receive = options.onEvent;
        return new Promise<void>((resolve) => { options.signal.addEventListener("abort", () => resolve(), { once: true }); });
      },
    };
  },
}));

const fakeRelay = (owners = [{ handle: "ada" }]) => {
  const created: { to: string[]; parts: unknown[] }[] = [];
  const sent: { chatId: string; parts: unknown[] }[] = [];
  const client = {
    me: { retrieve: async () => ({ handle: "iris.agent", owner_people: owners }) },
    chats: {
      create: async (body: { to: string[]; message: { parts: unknown[] } }) => {
        created.push({ to: body.to, parts: body.message.parts });
        return { chat: { id: `chat-with-${body.to[0]}`, message: { id: `card-${created.length}` } } };
      },
      messages: { send: async (chatId: string, body: { message: { parts: unknown[] } }) => { sent.push({ chatId, parts: body.message.parts }); return {}; } },
    },
  } as unknown as ApprovalClient;
  return { client, created, sent };
};

/** A tap on an approval card's reply, as `message.received` carries it. */
const tap = (card: string, handle: string, id: string): RelayWebhookEvent => ({
  event_id: `tap-${card}-${handle}-${id}`,
  event_type: "message.received",
  data: {
    id: `tap-${card}-${id}`, direction: "inbound",
    chat: { id: `chat-with-${handle}`, is_group: false },
    sender_handle: { handle, kind: "user" },
    parts: [{ type: "text", value: id }, { type: "suggestion_response", id: `${APPROVAL_REPLY_PREFIX}${id}`, label: id }],
    reply_to: { message_id: card, part_index: 0 },
  },
} as unknown as RelayWebhookEvent);

const ask = (value = "git push", grants = [{ surface: "bash", pattern: "git push *" }]): PermissionAsk => ({
  payload: { request: { surface: "bash", toolName: "bash", value } },
  sessionApproval: { grants },
});

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };

describe("the owner's approval card in session mode", () => {
  it("asks the owner with allow once, allow for session and deny, and an allow for session covers the same grant", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const link = relayAuthorizer({ approvals, fromRelay: () => true });
    const first = link.authorize(ask());
    await flush();
    expect(relay.created).toEqual([{ to: ["ada"], parts: [{
      type: "rich_card",
      title: "Pi asks to use bash.",
      description: "git push\n\nAllow for session covers git push *",
      suggestions: [
        { type: "reply", label: "Allow once", id: "relay-approval:allow_once" },
        { type: "reply", label: "Allow for session", id: "relay-approval:allow_session" },
        { type: "reply", label: "Deny", id: "relay-approval:deny" },
      ],
    }] }]);
    expect(await approvals.take(tap("card-1", "ada", "allow_session"))).toBe(true);
    expect(await first).toEqual({ kind: "allow" });
    // The same suggested grant is allowed without a second card; another one asks again.
    expect(await link.authorize(ask("git push origin"))).toEqual({ kind: "allow" });
    expect(relay.created).toHaveLength(1);
    void link.authorize(ask("rm -rf build", [{ surface: "bash", pattern: "rm *" }]));
    await flush();
    expect(relay.created).toHaveLength(2);
    link.reset();
    void link.authorize(ask("git push origin"));
    await flush();
    expect(relay.created).toHaveLength(3);
  });
  it("allows once without remembering it, and denies with the reason the model reads", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const link = relayAuthorizer({ approvals, fromRelay: () => true });
    const once = link.authorize(ask());
    await flush();
    await approvals.take(tap("card-1", "ada", "allow_once"));
    expect(await once).toEqual({ kind: "allow" });
    const denied = link.authorize(ask());
    await flush();
    expect(relay.created).toHaveLength(2);
    await approvals.take(tap("card-2", "ada", "deny"));
    expect(await denied).toEqual({ kind: "deny", reason: "The agent's owner denied this, so treating that as not approved." });
  });
  it("denies when the owner does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      const relay = fakeRelay();
      const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
      const verdict = relayAuthorizer({ approvals, fromRelay: () => true }).authorize(ask());
      await vi.advanceTimersByTimeAsync(599_999);
      let settled = false;
      void verdict.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await verdict).toEqual({ kind: "deny", reason: "The agent's owner did not answer in time, so treating that as not approved." });
      expect(relay.sent).toEqual([{ chatId: "chat-with-ada", parts: [{ type: "text", value: "Timed out, not approved." }] }]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("leaves a tap from anyone but an owner unregistered", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    const verdict = relayAuthorizer({ approvals, fromRelay: () => true, timeoutMs: 30 }).authorize(ask());
    await flush();
    expect(await approvals.take(tap("card-1", "mallory", "allow_session"))).toBe(true);
    expect(await verdict).toEqual({ kind: "deny", reason: expect.stringContaining("did not answer in time") });
  });
  it("defers to the app for a run no Relay Message started, an owner nobody can ask, and a path the chain caps", async () => {
    const relay = fakeRelay();
    const approvals = new OwnerApprovals({ client: relay.client, say: () => undefined });
    expect(await relayAuthorizer({ approvals, fromRelay: () => false }).authorize(ask())).toEqual({ kind: "defer" });
    expect(await relayAuthorizer({ approvals, fromRelay: () => true }).authorize({ payload: { request: { surface: "external_directory_write", toolName: "write", value: "/etc/hosts" } } })).toEqual({ kind: "defer" });
    expect(relay.created).toHaveLength(0);
    const ownerless = fakeRelay([]);
    expect(await relayAuthorizer({ approvals: new OwnerApprovals({ client: ownerless.client, say: () => undefined }), fromRelay: () => true }).authorize(ask())).toEqual({ kind: "defer" });
  });
  it("takes a tap on a card instead of giving it to the session as a Message", async () => {
    const pi = { sendUserMessage: vi.fn(), sendMessage: vi.fn() };
    const relay = { chats: { messages: { send: vi.fn() }, startTyping: vi.fn(), stopTyping: vi.fn() } } as unknown as Relay;
    const take = vi.fn(async (event: RelayWebhookEvent) => event.event_id.startsWith("tap-"));
    const channel = new SessionChannel(pi, { agentToken: "test", relay, isIdle: () => true, approvals: { take } });
    await channel.receive(tap("card-1", "ada", "allow_once"));
    expect(take).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(channel.fromRelay).toBe(false);
  });
  it("registers with the session's pi-permission-system under the name authorizerChain lists", () => {
    const registerAuthorizer = vi.fn(() => () => undefined);
    const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
    const store = globalThis as Record<symbol, unknown>;
    const before = store[key];
    store[key] = new Map([["session-1", { registerAuthorizer }]]);
    try {
      const authorize = vi.fn();
      expect(registerRelayAuthorizer("session-2", authorize)).toBeUndefined();
      expect(registerRelayAuthorizer("session-1", authorize)).toBeTypeOf("function");
      expect(registerAuthorizer).toHaveBeenCalledWith(RELAY_AUTHORIZER, authorize);
      expect(RELAY_AUTHORIZER).toBe("relay");
    } finally {
      store[key] = before;
    }
  });
  it("in a session-mode Pi, a gated call during a Relay Message's run is answered by the owner's tap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-session-approvals-"));
    const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
    const listeners = new Map<string, (data: unknown) => void>();
    const pi = {
      on: (name: string, handler: (event: unknown, context: unknown) => unknown) => { hooks.set(name, handler); },
      events: { on: (name: string, handler: (data: unknown) => void) => { listeners.set(name, handler); return () => undefined; }, emit: vi.fn() },
      registerCommand: vi.fn(), registerTool: vi.fn(), sendUserMessage: vi.fn(), sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    let link: ((ask: PermissionAsk) => Promise<unknown>) | undefined;
    const key = Symbol.for("@gotgenes/pi-permission-system:session-services");
    const store = globalThis as Record<symbol, unknown>;
    const before = store[key];
    store[key] = new Map([["pi-session", { registerAuthorizer: (name: string, authorize: typeof link) => { expect(name).toBe("relay"); link = authorize; return () => { link = undefined; }; } }]]);
    wire.created.length = 0;
    try {
      await writeFile(join(directory, "settings.json"), JSON.stringify({ relay: { mode: "session" } }));
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
      vi.stubEnv("RELAY_PI_MODE", "session");
      vi.stubEnv("RELAY_AGENT_TOKEN", "test");
      vi.stubEnv("RELAY_PI_CHAT_ID", "");
      vi.stubEnv("RELAY_BASE_URL", "https://relay.invalid");
      vi.stubEnv("PI_SUBAGENT_CHILD", "");
      native(pi);
      // pi-permission-system announces itself before Relay's session_start has finished.
      listeners.get("permissions:ready")!({ sessionId: "pi-session", adjudicatesLocally: true });
      expect(link).toBeUndefined();
      await hooks.get("session_start")!({}, { mode: "rpc", isIdle: () => true });
      expect(link).toBeTypeOf("function");
      // No Relay Message is being answered: the app asks.
      expect(await link!(ask())).toEqual({ kind: "defer" });
      await wire.receive!({
        event_type: "message.received", event_id: "event-1",
        data: { direction: "inbound", id: "m1", chat: { id: "chat-with-ada", is_group: false }, sender_handle: { handle: "ada", kind: "user" }, parts: [{ type: "text", value: "push it", reactions: null }] },
      } as RelayWebhookEvent);
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      const verdict = link!(ask());
      await flush();
      expect(wire.created).toHaveLength(1);
      await wire.receive!(tap("card-1", "ada", "allow_once"));
      expect(await verdict).toEqual({ kind: "allow" });
      // The tap answered the card; it is not a second Message.
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendMessage).not.toHaveBeenCalled();
      await hooks.get("session_shutdown")?.({}, {});
      expect(link).toBeUndefined();
    } finally {
      await hooks.get("session_shutdown")?.({}, {});
      wire.receive = undefined;
      store[key] = before;
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
