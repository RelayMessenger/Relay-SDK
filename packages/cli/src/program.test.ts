import type Relay from "@relaymessenger/sdk";
import { verifyWebhookSignature } from "@relaymessenger/sdk";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientContext } from "./client.js";
import { configPath } from "./config.js";
import { runCLI } from "./program.js";

const makeClient = () => {
  const methods = {
    listChats: vi.fn(async () => ({ chats: [{ id: "chat-1" }], nextCursor: null })),
    retrieveChat: vi.fn(async () => ({ id: "chat-1" })),
    updateChat: vi.fn(async () => ({ status: "accepted", chat_id: "chat-1" })),
    startTyping: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ chat_id: "chat-1" })),
    createChat: vi.fn(async () => ({ chat_id: "chat-1" })),
    sendToHandles: vi.fn(async () => ({ chat_id: "chat-1" })),
    react: vi.fn(async () => ({ status: "accepted" })),
    getCard: vi.fn(async () => ({ contact_cards: [] })),
    shareCard: vi.fn(async () => undefined),
    addParticipant: vi.fn(async () => ({ status: "accepted" })),
    removeParticipant: vi.fn(async () => ({ status: "accepted" })),
    webhookEvents: vi.fn(async () => ({ events: [], doc_url: "https://docs.relayapp.im" })),
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    retrieveMessage: vi.fn(async () => ({ id: "message-1", silent: true })),
  };
  const client = {
    chats: {
      create: methods.createChat,
      listChats: methods.listChats,
      retrieve: methods.retrieveChat,
      update: methods.updateChat,
      startTyping: methods.startTyping,
      messages: { send: methods.sendMessage, list: methods.listMessages },
      shareContactCard: methods.shareCard,
      participants: {
        add: methods.addParticipant,
        remove: methods.removeParticipant,
      },
    },
    messages: {
      addReaction: methods.react,
      create: methods.sendToHandles,
      retrieve: methods.retrieveMessage,
    },
    contactCard: { retrieve: methods.getCard },
    webhookEvents: { list: methods.webhookEvents },
  } as unknown as Relay;
  return { client, methods };
};

describe("CLI command routing", () => {
  let stdout: string[];
  let stderr: string[];
  let fake: ReturnType<typeof makeClient>;
  let resolveClient: (profile?: string) => Promise<ClientContext>;

  let privatePath: string;
  beforeEach(async () => {
    privatePath = join(await mkdtemp(join(tmpdir(), "relay-program-config-")), "config.json");
    stdout = [];
    stderr = [];
    fake = makeClient();
    resolveClient = vi.fn(async () => ({
      client: fake.client,
      auth: {
        profile: "default",
        apiURL: "https://api.staging.relayapp.im",
        token: "rly_test_secret",
        tokenSource: "environment",
        configPath: privatePath,
      },
    }));
  });

  const run = (args: string[]) => runCLI(args, {
    resolveClient,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    configContext: { env: { RELAY_AGENT_TOKEN: "rly_test_secret", RELAY_API_URL: "https://api.staging.relayapp.im", RELAY_CONFIG_PATH: privatePath } },
  });

  it("routes reads and typing through SDK resources", async () => {
    expect(await run(["chats", "list", "--limit", "20"])).toBe(0);
    expect(fake.methods.listChats).toHaveBeenCalledWith({ limit: 20 });
    expect(await run(["chats", "typing", "start", "chat-1"])).toBe(0);
    expect(fake.methods.startTyping).toHaveBeenCalledWith("chat-1");
  });

  it("passes --order through to the Chat message list and rejects other values", async () => {
    expect(await run([
      "chats", "messages", "list", "chat-1", "--limit", "20", "--order", "desc",
    ])).toBe(0);
    expect(fake.methods.listMessages).toHaveBeenCalledWith("chat-1", {
      limit: 20,
      order: "desc",
    });
    expect(await run([
      "chats", "messages", "list", "chat-1", "--order", "newest",
    ])).not.toBe(0);
    expect(fake.methods.listMessages).toHaveBeenCalledTimes(1);
  });

  it("requires stable idempotency for sends", async () => {
    expect(await run([
      "chats",
      "messages",
      "send",
      "chat-1",
      "--text",
      "hello",
      "--idempotency-key",
      "send-1",
    ])).toBe(0);
    expect(fake.methods.sendMessage).toHaveBeenCalledWith("chat-1", {
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "send-1",
      },
    });
    expect(await run([
      "chats",
      "messages",
      "send",
      "chat-1",
      "--text",
      "hello",
    ])).not.toBe(0);
  });

  it("--silent marks a Chat send silent, and its absence leaves the body alone", async () => {
    expect(await run([
      "chats", "messages", "send", "chat-1",
      "--text", "hello", "--idempotency-key", "send-silent", "--silent",
    ])).toBe(0);
    expect(fake.methods.sendMessage).toHaveBeenCalledWith("chat-1", {
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "send-silent",
        silent: true,
      },
    });
    expect(await run([
      "chats", "messages", "send", "chat-1",
      "--text", "hello", "--idempotency-key", "send-loud",
    ])).toBe(0);
    expect(fake.methods.sendMessage).toHaveBeenLastCalledWith("chat-1", {
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "send-loud",
      },
    });
  });

  it("--silent marks a handle send silent, and its absence leaves the body alone", async () => {
    expect(await run([
      "messages", "send", "--to", "advait",
      "--text", "hello", "--idempotency-key", "handles-silent", "--silent",
    ])).toBe(0);
    expect(fake.methods.sendToHandles).toHaveBeenCalledWith(expect.objectContaining({
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "handles-silent",
        silent: true,
      },
    }));
    expect(await run([
      "messages", "send", "--to", "advait",
      "--text", "hello", "--idempotency-key", "handles-loud",
    ])).toBe(0);
    expect(fake.methods.sendToHandles).toHaveBeenLastCalledWith(expect.objectContaining({
      message: {
        parts: [{ type: "text", value: "hello" }],
        idempotency_key: "handles-loud",
      },
    }));
  });

  it("messages get shows silent when the Message carries it", async () => {
    expect(await run(["messages", "get", "message-1"])).toBe(0);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ silent: true });
  });

  it("routes reactions, Contact Cards, and webhook metadata", async () => {
    expect(await run([
      "messages",
      "react",
      "message-1",
      "--operation",
      "add",
      "--type",
      "love",
    ])).toBe(0);
    expect(fake.methods.react).toHaveBeenCalledWith("message-1", {
      operation: "add",
      type: "love",
    });
    expect(await run(["contact-card", "get"])).toBe(0);
    expect(fake.methods.getCard).toHaveBeenCalledWith({});
    expect(await run(["webhooks", "events"])).toBe(0);
    expect(fake.methods.webhookEvents).toHaveBeenCalledOnce();
  });

  it("sends either group icon form and names both in the help", async () => {
    expect(await run([
      "chats",
      "update",
      "chat-1",
      "--group-icon",
      "https://example.com/icon.png",
    ])).toBe(0);
    expect(fake.methods.updateChat).toHaveBeenLastCalledWith("chat-1", {
      group_chat_icon: "https://example.com/icon.png",
    });
    expect(await run([
      "chats",
      "update",
      "chat-1",
      "--group-icon",
      "018f4b3c-1d2e-7a90-8c5f-6b1d2e3f4a5b",
    ])).toBe(0);
    expect(fake.methods.updateChat).toHaveBeenLastCalledWith("chat-1", {
      group_chat_icon: "018f4b3c-1d2e-7a90-8c5f-6b1d2e3f4a5b",
    });
    expect(await run(["chats", "update", "--help"])).toBe(0);
    expect(stdout.join("")).toContain("--group-icon <attachment-id-or-https-url>");
  });

  it("rejects malformed reactions before an SDK mutation", async () => {
    expect(await run([
      "messages",
      "react",
      "message-1",
      "--operation",
      "add",
      "--type",
      "custom",
    ])).toBe(1);
    expect(fake.methods.react).not.toHaveBeenCalled();
  });

  it("preserves generic participant commands and agent Contact Card sharing", async () => {
    expect(await run(["chats", "participants", "add", "chat-1", "research.dev"])).toBe(0);
    expect(fake.methods.addParticipant).toHaveBeenCalledWith("chat-1", { handle: "research.dev" });
    expect(await run(["chats", "participants", "remove", "chat-1", "research.dev"])).toBe(0);
    expect(fake.methods.removeParticipant).toHaveBeenCalledWith("chat-1", { handle: "research.dev" });
    expect(await run(["contact-card", "share", "chat-1"])).toBe(0);
    expect(fake.methods.shareCard).toHaveBeenCalledWith("chat-1");
  });

  it.each([
    ["--hide-history", true],
    ["--no-hide-history", false],
  ] as const)("passes %s to the SDK without losing false", async (flag, hideHistory) => {
    expect(await run(["chats", "participants", "add", "chat-1", "research.dev", flag])).toBe(0);
    expect(fake.methods.addParticipant).toHaveBeenCalledWith("chat-1", {
      handle: "research.dev",
      hide_history: hideHistory,
    });
  });

  it("explains agent-only selection without renaming participant commands", async () => {
    expect(await run(["chats", "participants", "--help"])).toBe(0);
    expect(stdout.join("")).toContain("add or remove agents in a chat");
    const help = stdout.join("").replace(/\s+/gu, " ");
    expect(help).toContain("the agent you add and the agent doing the adding must both be that person's contacts and not blocked");
    expect(help).toContain("The same holds for an agent that removes another");
    expect(help).toContain("An agent may always leave a chat itself");
    expect(stdout.join("")).toContain("add");
    expect(stdout.join("")).toContain("remove");
  });

  it("explains shared Chat permissions, Contacts eligibility, and participant limits", async () => {
    const help = () => stdout.join("").replace(/\s+/gu, " ");
    expect(await run(["chats", "--help"])).toBe(0);
    expect(help()).toContain("every agent in it must already be one of that person's contacts and not blocked");
    expect(help()).toContain("Chats between agents only need no such contact");
    stdout.length = 0;
    expect(await run(["chats", "create", "--help"])).toBe(0);
    expect(help()).toContain("at most 7 total participants, including the sender");
    expect(help()).toContain("at most 6 recipient Handles");
    stdout.length = 0;
    expect(await run(["messages", "send", "--help"])).toBe(0);
    expect(help()).toContain("at most 6 recipient Handles");
  });

  it("refuses to advance Agent event checkpoints without an explicit safe profile", async () => {
    expect(await run([
      "events",
      "listen",
      "--acknowledge-events",
    ])).toBe(1);
    expect(await run([
      "--profile",
      "production",
      "events",
      "listen",
      "--acknowledge-events",
    ])).toBe(1);
    expect(resolveClient).toHaveBeenCalledTimes(1);
  });

  it("listen forwards signed events to a loopback route and prints the secret once", async () => {
    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    (fake.client as unknown as { websocket: unknown }).websocket = {
      run: async (options: { onEvent(event: unknown, context: { sequence: string }): Promise<void> }) => {
        for (const id of ["evt-1", "evt-2"]) {
          await options.onEvent({
            api_version: "v1", webhook_version: "2026-02-03", event_type: "message.received", event_id: id,
            created_at: "2026-09-01T00:00:00.000Z", trace_id: "trace", agent_id: "agent", data: {},
          }, { sequence: id });
        }
      },
    } as never;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      posts.push({ body: init!.body as string, headers: init!.headers as Record<string, string> });
      return new Response(null, { status: 204 });
    });
    expect(await runCLI(["listen", "--forward-to", "http://localhost:3000/relay-events"], {
      resolveClient,
      fetch: fetchMock as unknown as typeof fetch,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      configContext: { env: { RELAY_CONFIG_PATH: privatePath } },
    })).toBe(0);
    const notes = stderr.join("");
    expect(notes).toContain("Forwarding events to http://localhost:3000/relay-events");
    expect(notes).toContain("Events read here count as delivered; a deployed webhook for this agent does not get them.");
    const secretLines = notes.split("\n").filter((line) => line.includes("Local signing secret"));
    expect(secretLines).toHaveLength(1);
    const secret = /whsec_[A-Za-z0-9+/=]+/u.exec(secretLines[0]!)![0];
    expect(secretLines[0]).toContain("(set RELAY_WEBHOOK_SECRET to it while you develop)");
    expect(posts).toHaveLength(2);
    for (const post of posts) expect(() => verifyWebhookSignature(secret, post.body, post.headers)).not.toThrow();
    expect(stdout.join("")).toContain("message.received · evt-1");
    // The secret is saved with the profile, so a second run prints the same one.
    stderr.length = 0;
    expect(await runCLI(["listen", "--forward-to", "http://localhost:3000/relay-events"], {
      resolveClient, fetch: fetchMock as unknown as typeof fetch,
      stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value),
      configContext: { env: { RELAY_CONFIG_PATH: privatePath } },
    })).toBe(0);
    expect(stderr.join("")).toContain(secret);
  });

  it("listen refuses an address off this computer and needs --forward-to", async () => {
    expect(await run(["listen", "--forward-to", "http://example.com/relay-events"])).not.toBe(0);
    expect(stderr.join("")).toContain("must be on this computer");
    stderr.length = 0;
    expect(await run(["listen"])).not.toBe(0);
    expect(stderr.join("")).toContain("required option '--forward-to <url>' not specified");
    stderr.length = 0;
    expect(await run(["listen", "--help"])).toBe(0);
    expect(stdout.join("")).toContain("forward each event to a route on this computer, signed like a webhook, while you develop");
  });

  it("redacts a token from thrown errors", async () => {
    resolveClient = vi.fn(async () => {
      throw new Error("upstream echoed rly_test_secret");
    });
    expect(await run(["chats", "list"])).toBe(1);
    const output = `${stdout.join("")}${stderr.join("")}`;
    expect(output).not.toContain("rly_test_secret");
    expect(output).toContain("[REDACTED]");
  });
});

describe("auth commands", { timeout: 120_000 }, () => {
  it("stores stdin tokens with owner-only config without printing them", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-cli-auth-"));
    const configContext = {
      home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
      platform: process.platform,
    };
    const stdout: string[] = [];
    const secret = "rly_stdin_secret_012345";
    const code = await runCLI(
      ["auth", "login", "--with-token", "--api-url", "https://api.staging.relayapp.im"],
      {
        configContext,
        readStdin: async () => secret,
        fetch: async () => Response.json({ contact_cards: [{ handle: "test_agent.dev", first_name: "Test", last_name: null, image_url: null, kind: "agent", is_active: true }] }),
        stdout: (value) => stdout.push(value),
        stderr: (value) => stdout.push(value),
      },
    );
    expect(code).toBe(0);
    expect(stdout.join("")).not.toContain(secret);
    expect(await readFile(configPath(configContext), "utf8")).toContain(secret);
    if (process.platform === "win32") {
      const { inspectConfigPermissions } = await import("./config.js");
      expect(await inspectConfigPermissions(configContext)).toMatchObject({ secure: true, aclChecked: true });
    }
  });

  it("does not accept a token as an argument", async () => {
    const output: string[] = [];
    const secret = "rly_argument_secret_012345";
    const code = await runCLI(
      ["auth", "login", "--with-token", secret],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => output.push(value),
      },
    );
    expect(code).not.toBe(0);
    expect(output.join("")).not.toContain(secret);
  });
});
