import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import Relay, { PAYMENT_GUIDANCE } from "@relaymessenger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApiURL } from "./auth.js";
import { createRelayMcpServer, executeOutputSchema, PACKAGE_VERSION, searchDocsOutputSchema, type RelayMcpServerOptions } from "./server.js";
import { WITHHELD_SECRET } from "./redact.js";
import { METHOD_DOCS } from "./generated-docs.js";
import pkg from "../package.json" with { type: "json" };
const TOKEN = "rel_token_mcp_test_secret_never_given_to_guest";
const CHAT = "01993d50-754d-7f51-a51b-5da552024fd1";
const sessions: Array<{ client: Client; server: ReturnType<typeof createRelayMcpServer> }> = [];
function sdk(fetch = vi.fn(async () => Response.json({ id: CHAT, handle: "fixture" }))) {
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
  it("discovers selection authoring and structured response types without resolving credentials", async () => {
    const resolveClient = vi.fn(async () => { throw new Error("must not resolve auth for search"); });
    const client = await connect({ resolveClient });
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "execute")?.description).toContain("selected_values");
    const found = await client.callTool({ name: "search_docs", arguments: { query: "selection", language: "typescript", detail: "verbose" } });
    expect(text(found)).toContain("SelectionPart");
    expect(text(found)).toContain("selected_values");
    expect(text(found)).toContain("• ");
    expect(tools.find(tool => tool.name === "execute")?.description).toContain("portable text remains bullets");
    expect(resolveClient).not.toHaveBeenCalled();
  });
  it("discovers the payment part and the payment request routes without resolving credentials", async () => {
    const resolveClient = vi.fn(async () => { throw new Error("must not resolve auth for search"); });
    const client = await connect({ resolveClient });
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "execute")?.description).toContain(PAYMENT_GUIDANCE);
    const found = await client.callTool({ name: "search_docs", arguments: { query: "payment", language: "typescript", detail: "verbose" } });
    expect(text(found)).toContain("client.paymentRequests.create");
    expect(text(found)).toContain("PaymentRequestCreateParams");
    expect(text(found)).toContain("PaymentPart");
    expect(resolveClient).not.toHaveBeenCalled();
  });
  it("discovers the location request and read routes without resolving credentials", async () => {
    const resolveClient = vi.fn(async () => { throw new Error("must not resolve auth for search"); });
    const client = await connect({ resolveClient });
    const found = await client.callTool({ name: "search_docs", arguments: { query: "location", language: "typescript", detail: "verbose" } });
    expect(text(found)).toContain("client.chats.location.request");
    expect(text(found)).toContain("client.chats.location.retrieve");
    expect(text(found)).toContain("GetChatLocationResponse");
    expect(resolveClient).not.toHaveBeenCalled();
  });
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
    expect(new Set(METHOD_DOCS.filter(x=>x.path.startsWith("/v1/")).map(x=>`${x.httpMethod} ${x.path}`)).size).toBe(56);
    expect(METHOD_DOCS.some(x=>x.method==="Relay.createAgent")).toBe(false);
    expect(METHOD_DOCS.some(x=>x.httpMethod==="POST"&&x.path==="/v1/agents")).toBe(false);
    const relay=sdk().client;
    for (const row of METHOD_DOCS.filter(x=>x.executable)) {
      let value:unknown=relay;
      for (const part of row.method.split(".").slice(1)) value=(value as Record<string,unknown>)[part];
      expect(typeof value,row.method).toBe("function");
    }
  });
  it("indexes and executes the A2A job calls tasks.send, tasks.get and tasks.cancel", async () => {
    expect(METHOD_DOCS.filter(x=>x.path==="{a2aBaseURL}/{to}").map(x=>[x.method,x.operationId,x.executable]).sort()).toEqual([
      ["client.tasks.cancel","CancelTask",true],["client.tasks.get","GetTask",true],["client.tasks.send","SendMessage",true],
    ]);
    const found=await (await connect()).callTool({name:"search_docs",arguments:{query:"tasks send job agent",language:"typescript",detail:"default"}});
    expect(text(found)).toContain("client.tasks.send");
    const task={id:"0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",contextId:"c",status:{state:"TASK_STATE_COMPLETED",timestamp:"2026-09-26T04:00:00.000Z"},metadata:{relay:{requester:{handle:"me"}}}};
    const card={name:"Worker",description:"",version:"1",capabilities:{},defaultInputModes:[],defaultOutputModes:[],skills:[],
      supportedInterfaces:[{url:"http://127.0.0.1:1/a2a/worker",protocolBinding:"JSONRPC",protocolVersion:"1.0"}]};
    const fetch=vi.fn(async (_input:unknown, init?:RequestInit) => init?.method==="POST"
      ? Response.json({jsonrpc:"2.0",id:JSON.parse(String(init.body)).id,result:task})
      : Response.json(card));
    const s=await ready({},sdk(fetch as never));
    const r=await s.execute(`async function run(client) { const t = await client.tasks.get({ to: "worker", id: ${JSON.stringify(task.id)} }); return t.status.state; }`);
    expect(r.isError).not.toBe(true); expect(result(r)).toBe("TASK_STATE_COMPLETED");
    const rpc=fetch.mock.calls.find(call=>call[1]?.method==="POST") as unknown as [string,RequestInit];
    expect(String(rpc[0])).toBe("http://127.0.0.1:1/a2a/worker");
    expect(new Headers(rpc[1].headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(rpc[1].body)).method).toBe("GetTask");
  });
  it("never shows a webhook signing_secret to the model or its code", async () => {
    const secret="whsec_c2lnbmluZy1zZWNyZXQtbmV2ZXItc2hvd24=";
    const fetch=vi.fn(async () => Response.json({id:"sub_1",target_url:"https://r.test/hook",subscribed_events:["message.received"],is_active:true,signing_secret:secret},{status:201}));
    const s=await ready({},sdk(fetch as never));
    const r=await s.execute('async function run(client) { const created = await client.webhookSubscriptions.create({ target_url: "https://r.test/hook", subscribed_events: ["message.received"] }); console.log(created.signing_secret); return created; }');
    expect(r.isError).not.toBe(true);
    expect(text(r)).not.toContain(secret);
    expect((result(r) as {signing_secret:string}).signing_secret).toBe(WITHHELD_SECRET);
    expect((result(r) as {id:string}).id).toBe("sub_1");
  });
  it("hands submitted code the SDK's JSON exactly: a null stays a present null, in objects and arrays", async () => {
    const community={handle:"mhacks",name:"MHacks",image_url:null,type:"public",member_count:null,owner:{kind:"organization",name:null,verified:false},members:[{handle:"a",subtitle:null}],tags:[null,"x",[null]]};
    const s=await ready({},sdk(vi.fn(async () => Response.json(community)) as never));
    const r=await s.execute(`async function run(client) {
      const c: any = await client.communities.retrieve("mhacks");
      return { isNull: c.member_count === null, isUndefined: c.member_count === undefined, has: "member_count" in c,
        keys: Object.keys(c), nestedNull: c.members[0].subtitle === null, nestedHas: "subtitle" in c.members[0],
        ownerNameNull: c.owner.name === null, arrayNull: c.tags[0] === null && 0 in c.tags, deepArrayNull: c.tags[2][0] === null,
        absent: "description" in c, whole: c };
    }`);
    expect(r.isError).not.toBe(true);
    expect(result(r)).toEqual({ isNull:true, isUndefined:false, has:true, keys:Object.keys(community), nestedNull:true, nestedHas:true,
      ownerNameNull:true, arrayNull:true, deepArrayNull:true, absent:false, whole:community });
  });
  it("declares an output schema for both tools that their structured content satisfies", async () => {
    const client=await connect();
    const tools=(await client.listTools()).tools;
    for (const name of ["search_docs","execute"]) {
      const tool=tools.find(x=>x.name===name)!;
      expect(tool.outputSchema?.type,name).toBe("object");
    }
    expect(Object.keys(tools.find(x=>x.name==="execute")!.outputSchema!.properties!).sort()).toEqual(["logs","result"]);
    expect(Object.keys(tools.find(x=>x.name==="search_docs")!.outputSchema!.properties!).sort()).toEqual(["contractSha256","language","note","query","results"]);
    const found=await client.callTool({name:"search_docs",arguments:{query:"payment",language:"typescript",detail:"verbose"}});
    expect(searchDocsOutputSchema.safeParse(found.structuredContent).success).toBe(true);
    const s=await ready(); const r=await s.execute('async function run() { console.log("x"); return { ok: true }; }');
    expect(executeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });
  it("does not advertise anonymous signup in documentation search", async () => {
    const client=await connect();
    const r=await client.callTool({name:"search_docs",arguments:{query:"anonymous agent signup",language:"typescript",detail:"verbose"}});
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r.structuredContent)).not.toContain("Relay.createAgent");
    expect(JSON.stringify(r.structuredContent)).not.toMatch(/POST\s+\/v1\/agents(?:["\s]|$)/);
  });
  it("runs TypeScript and captures return values and console output", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { const n: number = 2 + 2; console.log("answer", n); return { n, hasClient: !!client }; }');
    expect(r.isError).not.toBe(true); expect(result(r)).toEqual({n:4,hasClient:true}); expect(text(r)).toContain("answer 4"); expect(s.fixture.fetch).not.toHaveBeenCalled();
  });
  it("executes the real SDK with the existing Agent Token only on the host", async () => {
    const s=await ready(); const r=await s.execute('async function run(client) { return await client.contactCard.retrieve(); }');
    expect(r.isError).not.toBe(true); expect(result(r)).toEqual({id:CHAT,handle:"fixture"});
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
  it("discovers and executes guarded Chat activity through the generated SDK surface", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const activityId = "01995bc0-0000-7000-8000-000000000003";
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init: init! });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ chat_id: CHAT, agent_id: "agent", version: "9007199254740993", activity: {
        id: activityId, text: "Generating image", emoji: "🖼️",
        updated_at: "2026-09-20T12:00:00Z", expires_at: "2026-09-20T12:01:30Z",
      } });
    });
    const s = await ready({}, sdk(fetch));
    const docs = await s.client.callTool({ name: "search_docs", arguments: { query: "activity", detail: "verbose" } });
    expect(text(docs)).toContain("client.chats.setActivity");
    expect(text(docs)).toContain("activity_id");
    const response = await s.execute(`async function run(client) {
      const state = await client.chats.setActivity("${CHAT}", {text:"Generating image",emoji:"🖼️"});
      await client.chats.setActivity("${CHAT}", {text:"Generating image",emoji:"🖼️",activity_id:state.activity.id});
      const current = await client.chats.getActivity("${CHAT}");
      await client.chats.clearActivity("${CHAT}", {activity_id:state.activity.id});
      return current.version;
    }`);
    expect(response.isError).not.toBe(true);
    expect(result(response)).toBe("9007199254740993");
    expect(requests.map(({ init }) => init.method)).toEqual(["PUT", "PUT", "GET", "DELETE"]);
    expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ text: "Generating image", emoji: "🖼️", activity_id: activityId });
    expect(requests[3]!.url).toBe(`http://127.0.0.1:1/v1/chats/${CHAT}/activity?activity_id=${activityId}`);
    expect(requests[3]!.init.body).toBeUndefined();
    expect(text(response)).not.toContain(TOKEN);
  });
  it("discovers and executes only the public Contact lookup method", async () => {
    const s = await ready();
    const docs = await s.client.callTool({
      name: "search_docs",
      arguments: { query: "contacts lookup", detail: "verbose" },
    });
    expect(text(docs)).toContain("client.contacts.lookup");
    expect(text(docs)).toContain("/v1/contacts/lookup");
    expect(text(docs)).not.toMatch(/\b(?:is_request|request_expires_at|request_sender_id)\b/);
    const response = await s.execute('async function run(client) { return await client.contacts.lookup({handle:"alice"}); }');
    expect(response.isError).not.toBe(true);
    const request = s.fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request[0])).toBe("http://127.0.0.1:1/v1/contacts/lookup");
    expect(request[1].method).toBe("POST");
    expect(JSON.parse(String(request[1].body))).toEqual({ handle: "alice" });
    expect(METHOD_DOCS.filter(row => row.method.startsWith("client.contacts.")).map(row => row.method))
      .toEqual(["client.contacts.lookup"]);
    expect(METHOD_DOCS.find(row => row.method === "client.contacts.lookup")?.description)
      .toBe("Send a handle to look up one active contact: a person resolves agents; an agent resolves people and agents. Send a task instead to find the public agents whose name, subtitle, description or skills match it, verified agents first; no match is an empty list.");
  });
  it("does not document the reverted agent admission field", () => {
    for (const method of ["client.contactCard.create", "client.contactCard.retrieve", "client.contactCard.update"]) {
      const row = METHOD_DOCS.find(doc => doc.method === method);
      expect(row).toBeDefined();
      expect(row?.definitions.join("\n")).not.toMatch(/\bAgentMessageRequestsFrom\b|\bmessage_requests_from\??:/);
    }
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
  it("guards the other environment before network with only an environment token", async () => {
    // The build's own origin (staging for a -staging.N version, production for
    // the plain version the release job writes); any other origin is a leak.
    const requests: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      const url = String(input); requests.push(url);
      if (new URL(url).origin !== defaultApiURL()) throw new Error("OTHER ENVIRONMENT BLOCKED BEFORE NETWORK");
      return Response.json({ handle: "fixture" });
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
      expect(requests).toEqual([`${defaultApiURL()}/v1/contact_card`]);
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

it("round trips native selection authoring and rich response metadata through execute", async () => {
  const parts = [
    { type: "text", value: "• Research", reactions: null },
    { type: "selection_response", selected_values: ["research"] },
  ];
  const replyTo = { message_id: CHAT, part_index: 1 };
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ chat_id: CHAT, message: { id: "sent" } }, { status: 202 })
    : Response.json({ messages: [{ id: "response", parts, reply_to: replyTo }], next_cursor: null }));
  const s = await ready({}, sdk(fetch as never));
  const sent = await s.execute(`async function run(client) {
    return await client.chats.messages.send(${JSON.stringify(CHAT)}, { message: {
      parts: [{ type: "text", value: "Topics?" }, { type: "selection", options: [{ value: "research", label: "Research" }] }],
      idempotency_key: "mcp-selection"
    } });
  }`);
  expect(sent.isError).not.toBe(true);
  const request = fetch.mock.calls[0];
  expect(JSON.parse(String(request?.[1]?.body)).message.parts[1]).toEqual({
    type: "selection", options: [{ value: "research", label: "Research" }],
  });
  expect(new Headers(request?.[1]?.headers).get("idempotency-key")).toBe("mcp-selection");
  const read = await s.execute(`async function run(client) {
    const page = await client.chats.messages.list(${JSON.stringify(CHAT)});
    return page.data;
  }`);
  expect(read.isError).not.toBe(true);
  expect(result(read)).toEqual([{ id: "response", parts, reply_to: replyTo }]);
});

it("creates a payment request and sends its checkout_url as a solo payment part through execute", async () => {
  const fetch = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/v1/payment_requests")
    ? Response.json({ id: "request", object: "payment_request", checkout_url: "https://pay.relayapp.im/pr_token_123" }, { status: 201 })
    : Response.json({ chat_id: CHAT, message: { id: "sent" } }, { status: 202 }));
  const s = await ready({}, sdk(fetch as never));
  const sent = await s.execute(`async function run(client) {
    const request = await client.paymentRequests.create(
      { amount: 2400, currency: "usd", description: "House blend, 250 g", category: "physical_goods" },
      { idempotencyKey: "mcp-payment-request" },
    );
    return await client.chats.messages.send(${JSON.stringify(CHAT)}, { message: {
      parts: [{ type: "payment", checkout_url: request.checkout_url }], idempotency_key: "mcp-payment"
    } });
  }`);
  expect(sent.isError).not.toBe(true);
  const [create, send] = fetch.mock.calls as unknown as [string, RequestInit][];
  expect(String(create?.[0])).toBe("http://127.0.0.1:1/v1/payment_requests");
  expect(create?.[1]?.method).toBe("POST");
  expect(new Headers(create?.[1]?.headers).get("idempotency-key")).toBe("mcp-payment-request");
  expect(JSON.parse(String(create?.[1]?.body))).toEqual({ amount: 2400, currency: "usd", description: "House blend, 250 g", category: "physical_goods" });
  expect(JSON.parse(String(send?.[1]?.body)).message.parts).toEqual([{ type: "payment", checkout_url: "https://pay.relayapp.im/pr_token_123" }]);
  expect(new Headers(send?.[1]?.headers).get("idempotency-key")).toBe("mcp-payment");
});
