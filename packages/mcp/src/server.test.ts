import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import Relay from "@relaymessenger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayMcpServer, PACKAGE_VERSION, type RelayMcpServerOptions } from "./server.js";
import { METHOD_DOCS } from "./generated-docs.js";
import pkg from "../package.json" with { type: "json" };
const TOKEN = "rel_token_mcp_test_secret_never_given_to_guest";
const CHAT = "01993d50-754d-7f51-a51b-5da552024fd1";
const sessions: Array<{ client: Client; server: ReturnType<typeof createRelayMcpServer> }> = [];
function sdk(fetch = vi.fn(async () => Response.json({ id: CHAT, handle: "fixture.dev" }))) {
  return { fetch, client: new Relay({ apiKey: TOKEN, baseURL: "http://127.0.0.1:1", maxRetries: 0, fetch }) };
}
async function connect(options: RelayMcpServerOptions = {}) {
  const [a,b] = InMemoryTransport.createLinkedPair();
  const server = createRelayMcpServer(options);
  const client = new Client({ name: "relay-two-tool-test", version: "1.0.0" });
  await Promise.all([server.connect(b), client.connect(a)]);
  sessions.push({client,server}); return client;
}
async function ready(overrides: RelayMcpServerOptions = {}, fixture = sdk()) {
  const client = await connect({ resolveClient: async () => ({ client: fixture.client, secrets: [TOKEN] }), collectSecrets: async () => [TOKEN], ...overrides });
  return { client, fixture, execute: (code: string) => client.callTool({ name: "execute", arguments: { code } }) };
}
const text = (r: unknown) => JSON.stringify(r);
const result = (r: unknown) => (r as { structuredContent?: { result?: unknown } }).structuredContent?.result;
afterEach(async () => { await Promise.all(sessions.splice(0).map(async s => { await s.client.close(); await s.server.close(); })); });

describe("approved two-tool MCP", () => {
  it("advertises exactly search_docs and execute, without credential arguments or talk", async () => {
    const client = await connect(); const tools = (await client.listTools()).tools;
    expect(tools.map(x=>x.name).sort()).toEqual(["execute","search_docs"]);
    expect(tools.some(x=>JSON.stringify(x.inputSchema).includes("token"))).toBe(false);
    expect(tools.find(x=>x.name==="search_docs")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(x=>x.name==="execute")?.annotations?.readOnlyHint).toBe(false);
    expect(PACKAGE_VERSION).toBe(pkg.version);
    for (const name of ["relay_list_chats", "relay_send_message", "talk"]) await expect(client.callTool({ name, arguments:{} })).rejects.toThrow(/not found/i);
  });
  it("searches the shipped SDK/contract locally without credentials", async () => {
    const resolveClient = vi.fn(async () => { throw new Error("must not resolve auth for search"); });
    const client = await connect({resolveClient});
    const r = await client.callTool({name:"search_docs",arguments:{query:"send message",language:"typescript"}});
    expect(r.isError).not.toBe(true); expect(text(r)).toContain("client.chats.messages.send");
    expect(text(r)).toContain("idempotency_key"); expect(text(r)).toContain("MessageSendParams");
    expect(resolveClient).not.toHaveBeenCalled();
  });
  it("returns no fabricated method for an unrelated query", async () => {
    const client = await connect(); const r=await client.callTool({name:"search_docs",arguments:{query:"zzzzzzzzunknownxyz",language:"http"}});
    expect((r.structuredContent as {results:unknown[]}).results).toEqual([]);
  });
  it("redacts a known token accidentally pasted into a documentation query", async () => {
    const s=await ready();
    const r=await s.client.callTool({name:"search_docs",arguments:{query:TOKEN}});
    expect(r.isError).not.toBe(true); expect(text(r)).not.toContain(TOKEN); expect(text(r)).toContain("[REDACTED]");
  });
  it("indexes every HTTP operation and exposes only initialized client methods", () => {
    expect(new Set(METHOD_DOCS.map(x=>`${x.httpMethod} ${x.path}`)).size).toBe(35);
    expect(METHOD_DOCS.find(x=>x.method==="Relay.createAgent")?.executable).toBe(false);
    const relay=sdk().client;
    for (const row of METHOD_DOCS.filter(x=>x.executable)) {
      let value:unknown=relay;
      for (const part of row.method.split(".").slice(1)) value=(value as Record<string,unknown>)[part];
      expect(typeof value,row.method).toBe("function");
    }
  });
  it("runs TypeScript and captures return values and console output", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { const n: number = 2 + 2; console.log("answer", n); return { n, hasClient: !!client }; }');
    expect(r.isError).not.toBe(true); expect(result(r)).toEqual({n:4,hasClient:true}); expect(text(r)).toContain("answer 4"); expect(s.fixture.fetch).not.toHaveBeenCalled();
  });
  it("executes the real SDK with the existing Agent Token only on the host", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { return await client.contactCard.retrieve(); }');
    expect(r.isError).not.toBe(true); expect(result(r)).toEqual({id:CHAT,handle:"fixture.dev"});
    const request=s.fixture.fetch.mock.calls[0] as unknown as [string,RequestInit];
    expect(String(request[0])).toBe("http://127.0.0.1:1/v1/contact_card");
    expect(new Headers(request[1].headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(text(r)).not.toContain(TOKEN);
  });
  it("chains SDK calls and preserves idempotency and typed parameters", async () => {
    const fetch=vi.fn(async () => Response.json({chat_id:CHAT,message:{id:"sent"}}, {status:202})); const s=await ready({},sdk(fetch));
    const r=await s.execute(`async function run(client) { return await client.chats.messages.send(${JSON.stringify(CHAT)}, {message:{parts:[{type:"text",value:"fixture only"}],idempotency_key:"mcp-two-tools-test"}}); }`);
    expect(r.isError).not.toBe(true); const req=fetch.mock.calls[0] as unknown as [string,RequestInit];
    expect(String(req[0])).toContain(`/v1/chats/${CHAT}/messages`); expect(new Headers(req[1].headers).get("idempotency-key")).toBe("mcp-two-tools-test");
  });
  it("preserves SDK pagination methods and async iteration", async () => {
    const fetch=vi.fn(async (url: unknown) => Response.json(String(url).includes("cursor=next") ? {chats:[{id:"second"}],next_cursor:null} : {chats:[{id:"first"}],next_cursor:"next"}));
    const s=await ready({},sdk(fetch)); const r=await s.execute('async function run(client) { const page = await client.chats.listChats(); const next = page.hasNextPage(); const ids = []; for await (const item of page) ids.push(item.id); return {next,ids}; }');
    expect(r.isError).not.toBe(true); expect(result(r)).toEqual({next:true,ids:["first","second"]}); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("returns backend errors for invalid tokens and redacts collected credentials", async () => {
    const fetch=vi.fn(async () => Response.json({error:{message:`Denied ${TOKEN}`,code:2004,status:401}}, {status:401})); const s=await ready({},sdk(fetch));
    const r=await s.execute('async function run(client) { return await client.contactCard.retrieve(); }');
    expect(r.isError).toBe(true); expect(text(r)).toContain("[REDACTED]"); expect(text(r)).not.toContain(TOKEN);
  });
  it("preserves HTTP status when submitted code handles an SDK error", async () => {
    const fetch=vi.fn(async () => Response.json({error:{message:"Denied",status:401}}, {status:401})); const s=await ready({},sdk(fetch));
    const r=await s.execute('async function run(client) { try { await client.contactCard.retrieve(); } catch (error) { return {status:error.status}; } }');
    expect(result(r)).toEqual({status:401});
  });
  it("keeps tokens out of reflected client state, results, logs, and errors", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { console.log(client); return {hasKey: "apiKey" in client, hasTransport: "transport" in client.chats, constructor: typeof client.constructor}; }');
    expect(result(r)).toEqual({hasKey:false,hasTransport:false,constructor:"undefined"}); expect(text(r)).not.toContain(TOKEN);
    const echoed=await s.execute(`async function run(client) { console.log(${JSON.stringify(TOKEN)}); return ${JSON.stringify(TOKEN)}; }`);
    expect(text(echoed)).not.toContain(TOKEN); expect(text(echoed)).toContain("[REDACTED]");
  });
  it("uses the same missing-token error without inventing credentials", async () => {
    const client=await connect({authContext:{env:{RELAY_CONFIG_PATH:"/tmp/relay-mcp-definitely-absent-profile-two-tools.json",RELAY_API_URL:"http://127.0.0.1:1"}}});
    const r=await client.callTool({name:"execute",arguments:{code:"async function run(client) { return 4; }"}});
    expect(r.isError).toBe(true); expect(text(r)).toContain("No Agent Token");
  });
  it("guards production before network with only an environment token in a staging build", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      const url = String(input); requests.push(url);
      if (new URL(url).origin === "https://api.relayapp.im") throw new Error("PRODUCTION BLOCKED BEFORE NETWORK");
      return Response.json({ handle: "fixture.dev" });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const client = await connect({ authContext: { env: {
        RELAY_AGENT_TOKEN: TOKEN,
        RELAY_CONFIG_PATH: "/tmp/relay-mcp-fresh-only-token-absent.json",
      } } });
      const docs = await client.callTool({name:"search_docs",arguments:{query:"contact card"}});
      expect(docs.isError).not.toBe(true); expect(requests).toEqual([]);
      const r = await client.callTool({name:"execute",arguments:{code:"async function run(client) { return await client.contactCard.retrieve(); }"}});
      expect(r.isError).not.toBe(true);
      expect(requests).toEqual(["https://api.staging.relayapp.im/v1/contact_card"]);
    } finally { vi.unstubAllGlobals(); }
  });
  it("does not expose process, shell, filesystem, arbitrary fetch, or host constructors", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { return [typeof process, typeof require, typeof fetch, typeof Deno, typeof Buffer, console.log.constructor("return typeof process")()]; }');
    expect(result(r)).toEqual(Array(6).fill("undefined"));
    for (const code of ['async function run(client) { return require("node:fs"); }','async function run(client) { return client.chats.constructor.constructor("return process")(); }']) expect((await s.execute(code)).isError).toBe(true);
  });
  it("rejects imports, missing run, bad syntax, and invented SDK methods", async () => {
    const s=await ready();
    for (const code of ['import fs from "node:fs"; async function run(client) {}','const n = 1;','async function run(client) { let = ; }','async function run(client) { return client.talk(); }']) expect((await s.execute(code)).isError,code).toBe(true);
  });
  it("does not persist guest globals between calls", async () => {
    const s=await ready(); await s.execute('async function run(client) { globalThis.saved = 42; return 42; }');
    expect(result(await s.execute('async function run(client) { return typeof globalThis.saved; }'))).toBe("undefined");
  });
  it("interrupts infinite loops and unresolved promises", async () => {
    const s=await ready({executionLimits:{timeoutMs:75}});
    for (const code of ['async function run(client) { while (true) {} }','async function run(client) { await new Promise(() => {}); }']) { const r=await s.execute(code); expect(r.isError).toBe(true); expect(text(r)).toMatch(/timed out|interrupt/i); }
  });
  it("bounds output and still accepts a later execution", async () => {
    const s=await ready({executionLimits:{outputBytes:512}});
    expect((await s.execute('async function run(client) { return "x".repeat(5000); }')).isError).toBe(true);
    expect(result(await s.execute('async function run(client) { return 4; }'))).toBe(4);
  });
  it("bounds guest memory without breaking a later runtime", async () => {
    const s=await ready({executionLimits:{memoryBytes:2*1024*1024}});
    expect((await s.execute('async function run(client) { return "x".repeat(10_000_000); }')).isError).toBe(true);
    expect(result(await s.execute('async function run(client) { return 4; }'))).toBe(4);
  });
  it("cancels pending SDK requests when the execution ends", async () => {
    let cancelled = false;
    const fetch=vi.fn(async (_input: unknown, options: RequestInit | undefined) => new Promise<Response>((_resolve,reject) => {
      options?.signal?.addEventListener("abort", () => { cancelled=true; reject(new Error("cancelled")); }, {once:true});
    }));
    const s=await ready({executionLimits:{timeoutMs:75}},sdk(fetch));
    expect((await s.execute('async function run(client) { return await client.contactCard.retrieve(); }')).isError).toBe(true);
    await new Promise(resolve=>setTimeout(resolve,10));
    expect(cancelled).toBe(true);
  });
});
