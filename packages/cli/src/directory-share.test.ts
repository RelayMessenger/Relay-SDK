import Relay from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { runCLI } from "./program.js";

async function run(args: string[]) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const client = new Relay({ apiKey: "fixture-token", fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return init?.method === "GET" ? Response.json({ agents: [] }) : new Response(null, { status: 204 });
  } });
  const search = vi.spyOn(client.directory, "search");
  const share = vi.spyOn(client.chats, "shareContactCard");
  const code = await runCLI([...args, "--json"], {
    resolveClient: async () => ({ client, auth: { profile: "fixture", apiURL: client.baseURL,
      token: "fixture-token", tokenSource: "environment", configPath: "/unused" } }),
    stdout: value => stdout.push(value), stderr: value => stderr.push(value),
  });
  return { code, calls, stdout, stderr, search, share };
}

describe("directory and contact sharing commands", () => {
  it("maps directory search flags through the SDK to the public GET", async () => {
    const result = await run(["directory", "search", "--q", "trains & hotels", "--category", "travel", "--limit", "7", "--sort", "newest"]);
    expect(result.code, result.stderr.join("")).toBe(0);
    expect(result.search).toHaveBeenCalledWith({ q: "trains & hotels", category: "travel", limit: 7, sort: "newest" });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.url.pathname).toBe("/v1/directory");
    expect(Object.fromEntries(result.calls[0]!.url.searchParams)).toEqual({ q: "trains & hotels", category: "travel", limit: "7", sort: "newest" });
    expect(JSON.parse(result.stdout.join(""))).toEqual({ agents: [] });
  });

  it("searches without imposing client defaults", async () => {
    const result = await run(["directory", "search"]);
    expect(result.code, result.stderr.join("")).toBe(0);
    expect(result.search).toHaveBeenCalledWith({});
    expect(result.calls[0]!.url.search).toBe("");
  });

  it.each([undefined, "travel_bot"])("shares %s through the SDK", async (handle) => {
    const result = await run(["chats", "share-contact-card", "chat/id", ...(handle ? ["--handle", handle] : [])]);
    expect(result.code, result.stderr.join("")).toBe(0);
    expect(result.share).toHaveBeenCalledWith("chat/id", handle ? { handle } : undefined);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.url.pathname).toBe("/v1/chats/chat%2Fid/share_contact_card");
    expect(result.calls[0]!.init?.method).toBe("POST");
    expect(result.calls[0]!.init?.body).toBe(handle ? JSON.stringify({ handle }) : undefined);
  });
});
