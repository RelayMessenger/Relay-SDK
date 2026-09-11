import type Relay from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";

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
    [["--to", "alice.dev"], ["alice.dev"]],
    [["--to", "alice.dev", "bob.dev"], ["alice.dev", "bob.dev"]],
    [["--to", "alice.dev", "--to", "bob.dev"], ["alice.dev", "bob.dev"]],
    [["--to", "alice.dev, bob.dev"], ["alice.dev", "bob.dev"]],
    [["--to", "a,b", "c", "--to", "d,e,f"], ["a", "b", "c", "d", "e", "f"]],
  ])("sends %j to the handles named", async (args, to) => {
    const result = await send(args);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.bodies).toEqual([{
      to, message: { parts: [{ type: "text", value: "Hello" }], idempotency_key: "messages-send-test" },
    }]);
  });

  it.each([[], ["--to", ""], ["--to", "alice,,bob"], ["--to", "@alice"],
    ["--to", "a,b,c,d,e,f,g"]].map((args) => ({ args })))("refuses %j before it sends anything", async ({ args }) => {
    const result = await send(args);
    expect(result.code).not.toBe(0);
    expect(result.bodies).toEqual([]);
  });
});
