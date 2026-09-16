import type Relay from "@relaymessenger/sdk";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";
import { writeFolderLink } from "./folder-link.js";

// `--to` is a variadic option with a coercion, and Commander hands a coercion
// each value with what it kept so far. Returning one handle left a string in
// `to`, so a single recipient was counted by its letters and refused with "at
// most 6 recipient Handles" (measured against staging on 2026-09-11).
async function send(args: string[]) {
  const bodies: unknown[] = [];
  const create = vi.fn(async (body: unknown) => { bodies.push(body); return { chat_id: "chat-1" }; });
  const stderr: string[] = [];
  const code = await runCLI(["messages", "send", ...args, "--text", "Hello", "--idempotency-key", "messages-send-test"], {
    resolveClient: async () => ({
      client: { messages: { create } } as unknown as Relay,
      auth: {
        profile: "default", apiURL: "https://api.relayapp.im", token: "rly_test_secret",
        tokenSource: "environment", configPath: "/unused",
      },
    }),
    stdout: () => {}, stderr: (value) => stderr.push(value),
  });
  return { code, bodies, stderr };
}

describe("messages send recipients", () => {
  it.each([
    [["--to", "@alice"], ["alice"]],
    [["--to", "alice"], ["alice"]],
    [["--to", "alice", "bob"], ["alice", "bob"]],
    [["--to", "alice", "--to", "bob"], ["alice", "bob"]],
    [["--to", "alice, bob"], ["alice", "bob"]],
    [["--to", "a,b", "c", "--to", "d,e,f"], ["a", "b", "c", "d", "e", "f"]],
  ])("sends %j to the handles named", async (args, to) => {
    const result = await send(args);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.bodies).toEqual([{
      to, message: { parts: [{ type: "text", value: "Hello" }], idempotency_key: "messages-send-test" },
    }]);
  });

  it.each([[], ["--to", ""], ["--to", "alice,,bob"],
    ["--to", "a,b,c,d,e,f,g"]].map((args) => ({ args })))("refuses %j before it sends anything", async ({ args }) => {
    const result = await send(args);
    expect(result.code).not.toBe(0);
    expect(result.bodies).toEqual([]);
  });
});

describe("messages send identity", () => {
  it("a linked folder sends as its linked agent; --profile still overrides", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-send-link-"));
    const folder = join(home, "project");
    await mkdir(folder);
    const linked = `rel_token_${"L".repeat(43)}`;
    const other = `rel_token_${"O".repeat(43)}`;
    await writeFile(join(home, "config.json"), JSON.stringify({
      version: 1, current_profile: "other",
      profiles: { "other": { api_url: "https://api.relayapp.im", agent_token: other }, "linked": { api_url: "https://api.relayapp.im", agent_token: linked } },
    }), { mode: 0o600 });
    await writeFolderLink(folder, { handle: "linked", apiUrl: "https://api.relayapp.im" });
    const sent: string[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(new Headers(init?.headers).get("authorization")));
      return Response.json({ chat_id: "chat-1" });
    });
    const run = (args: string[]) => runCLI(["messages", "send", ...args, "--to", "alice", "--text", "Hello", "--idempotency-key", "k"], {
      configContext: { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, home, platform: process.platform },
      cwd: folder, fetch, stdout: () => {}, stderr: () => {},
    });
    expect(await run([])).toBe(0);
    expect(await run(["--profile", "other"])).toBe(0);
    expect(sent).toEqual([`Bearer ${linked}`, `Bearer ${other}`]);
  });
});


describe.each([
  { name: "messages send", args: ["messages", "send", "--to", "alice"], path: "/v1/messages" },
  { name: "chats messages send", args: ["chats", "messages", "send", "chat-1"], path: "/v1/chats/chat-1/messages" },
])("$name idempotency", ({ args, path }) => {
  it.each([undefined, "caller-supplied-key"])("sends a request with key %s", async (key) => {
    const home = await mkdtemp(join(tmpdir(), "relay-send-idempotency-"));
    const requests: { url: string; key: string | null; body: { message: { idempotency_key?: string } } }[] = [];
    const stderr: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        key: new Headers(init?.headers).get("Idempotency-Key"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ chat_id: "chat-1", message_id: "message-1" });
    });
    const code = await runCLI([...args, "--text", "Hello",
      ...(key === undefined ? [] : ["--idempotency-key", key])], {
      configContext: { env: {
        RELAY_AGENT_TOKEN: "rly_test_secret", RELAY_API_URL: "https://api.relayapp.im",
        RELAY_CONFIG_PATH: join(home, "config.json"),
      }, home, platform: process.platform },
      cwd: home, fetch, stdout: () => {}, stderr: (value) => stderr.push(value),
    });
    expect(code, stderr.join("\n")).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`https://api.relayapp.im${path}`);
    if (key === undefined) {
      expect(requests[0].body.message.idempotency_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } else {
      expect(requests[0].body.message.idempotency_key).toBe(key);
    }
    expect(requests[0].key).toBe(requests[0].body.message.idempotency_key);
  });
});
