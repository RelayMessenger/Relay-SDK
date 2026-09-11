import type Relay from "@relaymessenger/sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { runCLI } from "./program.js";

const contract = YAML.parse(readFileSync(new URL("../../../contracts/relay-v1-openapi.yaml", import.meta.url), "utf8"));
const requestSchema = contract.paths["/v1/chats"].post.requestBody.content["application/json"].schema;

// Minimal JSON Schema validation for the request's objects, arrays, strings and
// union branches. All constraints come from the canonical vendored contract.
function validate(value: unknown, schema: any, path = "body"): void {
  if (schema.$ref) {
    validate(value, schema.$ref.slice(2).split("/").reduce((node: any, key: string) => node[key], contract), path);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch: any) => {
      try { validate(value, branch, path); return true; } catch { return false; }
    });
    expect(matches, `${path} must match exactly one schema`).toHaveLength(1);
  }
  if (schema.type) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    expect([schema.type].flat(), `${path} must have schema type ${schema.type}`).toContain(type);
  }
  if (schema.enum) expect(schema.enum, path).toContain(value);
  if (typeof value === "string") {
    if (schema.minLength !== undefined) expect(value.length, path).toBeGreaterThanOrEqual(schema.minLength);
    if (schema.maxLength !== undefined) expect(value.length, path).toBeLessThanOrEqual(schema.maxLength);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) expect(value.length, path).toBeGreaterThanOrEqual(schema.minItems);
    if (schema.maxItems !== undefined) expect(value.length, path).toBeLessThanOrEqual(schema.maxItems);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const key of schema.required ?? []) expect(value, path).toHaveProperty(key);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key} is not allowed`);
    }
  }
}

async function create(args: string[]) {
  const bodies: unknown[] = [];
  const createChat = vi.fn(async (body: unknown) => { bodies.push(body); return { chat_id: "chat-1" }; });
  const stderr: string[] = [];
  const code = await runCLI(["chats", "create", "--from", "sender", ...args,
    "--text", "Hello", "--idempotency-key", "chats-create-test"], {
    resolveClient: async () => ({
      client: { chats: { create: createChat } } as unknown as Relay,
      auth: { profile: "default", apiURL: "https://api.relayapp.im", token: "rly_test_secret",
        tokenSource: "environment", configPath: "/unused" },
    }),
    stdout: () => {}, stderr: (value) => stderr.push(value),
  });
  return { code, bodies, stderr };
}

describe("chats create request contract", () => {
  it.each([
    [["--to", "a"], ["a"]],
    [["--to", "alice", "bob"], ["alice", "bob"]],
    [["--to", "alice", "--to", "bob"], ["alice", "bob"]],
    [["--to", "alice, bob"], ["alice", "bob"]],
    [["--to", "a,b", "c", "--to", "d,e,f"], ["a", "b", "c", "d", "e", "f"]],
  ])("validates parsed recipients %j against POST /v1/chats", async (args, recipients) => {
    const result = await create(args);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.bodies).toHaveLength(1);
    validate(result.bodies[0], requestSchema);
    expect(result.bodies[0]).toEqual({ from: "sender", to: recipients,
      message: { parts: [{ type: "text", value: "Hello" }], idempotency_key: "chats-create-test" } });
  });

  it.each([[], ["--to", ""], ["--to", "alice,,bob"], ["--to", "@alice"],
    ["--to", "a,b,c,d,e,f,g"]].map((args) => ({ args })))("rejects invalid recipients $args before calling the SDK", async ({ args }) => {
    const result = await create(args);
    expect(result.code).not.toBe(0);
    expect(result.bodies).toHaveLength(0);
  });
});
