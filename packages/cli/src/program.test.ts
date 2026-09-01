import type Relay from "@relaymessenger/sdk";
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
    startTyping: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ chat_id: "chat-1" })),
    react: vi.fn(async () => ({ status: "accepted" })),
    getCard: vi.fn(async () => ({ contact_cards: [] })),
    createRequest: vi.fn(async () => ({ state: "pending" })),
    webhookEvents: vi.fn(async () => ({ events: [], doc_url: "https://docs.relayapp.im" })),
  };
  const client = {
    chats: {
      listChats: methods.listChats,
      retrieve: methods.retrieveChat,
      startTyping: methods.startTyping,
      messages: { send: methods.sendMessage },
    },
    messages: { addReaction: methods.react },
    contactCard: { retrieve: methods.getCard },
    contactRequests: { create: methods.createRequest },
    webhookEvents: { list: methods.webhookEvents },
  } as unknown as Relay;
  return { client, methods };
};

describe("CLI command routing", () => {
  let stdout: string[];
  let stderr: string[];
  let fake: ReturnType<typeof makeClient>;
  let resolveClient: (profile?: string) => Promise<ClientContext>;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    fake = makeClient();
    resolveClient = vi.fn(async () => ({
      client: fake.client,
      auth: {
        profile: "default",
        apiURL: "https://api.relayapp.im",
        token: "rly_test_secret",
        tokenSource: "environment",
        configPath: "/tmp/relay-config",
      },
    }));
  });

  const run = (args: string[]) => runCLI(args, {
    resolveClient,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    configContext: { env: { RELAY_AGENT_TOKEN: "rly_test_secret" } },
  });

  it("routes reads and typing through SDK resources", async () => {
    expect(await run(["chats", "list", "--limit", "20"])).toBe(0);
    expect(fake.methods.listChats).toHaveBeenCalledWith({ limit: 20 });
    expect(await run(["chats", "typing", "start", "chat-1"])).toBe(0);
    expect(fake.methods.startTyping).toHaveBeenCalledWith("chat-1");
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

  it("routes reactions, Contact Cards, requests, and webhook metadata", async () => {
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
    expect(await run(["contact-requests", "create", "advait"])).toBe(0);
    expect(fake.methods.createRequest).toHaveBeenCalledWith({ handle: "advait" });
    expect(await run(["webhooks", "events"])).toBe(0);
    expect(fake.methods.webhookEvents).toHaveBeenCalledOnce();
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

describe("authentication commands", () => {
  it("stores stdin tokens with owner-only config without printing them", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-cli-auth-"));
    const configContext = {
      home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
      platform: "linux" as const,
    };
    const stdout: string[] = [];
    const secret = "rly_stdin_secret_012345";
    const code = await runCLI(
      ["auth", "login", "--token-stdin"],
      {
        configContext,
        readStdin: async () => secret,
        stdout: (value) => stdout.push(value),
        stderr: (value) => stdout.push(value),
      },
    );
    expect(code).toBe(0);
    expect(stdout.join("")).not.toContain(secret);
    expect(await readFile(configPath(configContext), "utf8")).toContain(secret);
  });

  it("does not accept a token as an argument", async () => {
    const output: string[] = [];
    const secret = "rly_argument_secret_012345";
    const code = await runCLI(
      ["auth", "login", "--token", secret],
      {
        stdout: (value) => output.push(value),
        stderr: (value) => output.push(value),
      },
    );
    expect(code).not.toBe(0);
    expect(output.join("")).not.toContain(secret);
  });
});
