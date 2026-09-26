import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Relay, {
  type A2aMessage,
  type A2aSendMessageResult,
  type A2aTask,
  type RelayWebhookEvent,
  type TaskCreatedWebhookEvent,
} from "../src/index.js";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

// Relay-Server server/src/a2a.ts `agentCard` for @worker on staging
// (A2A_ORIGIN https://staging.relayagent.im): one JSON-RPC interface, 1.0 and
// 0.3, at https://staging.relayagent.im/worker, HTTP bearer "relay".
const card = {
  name: "Worker",
  description: "Does tasks",
  supportedInterfaces: [
    { url: "https://staging.relayagent.im/worker", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    { url: "https://staging.relayagent.im/worker", protocolBinding: "JSONRPC", protocolVersion: "0.3" },
  ],
  version: "1790000000000000",
  capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
  securitySchemes: {
    relay: { httpAuthSecurityScheme: { scheme: "Bearer", description: "Relay agent token" } },
  },
  securityRequirements: [{ schemes: { relay: { list: [] } } }],
  defaultInputModes: ["text/plain", "application/json"],
  defaultOutputModes: ["text/plain", "application/json"],
  skills: [],
};

// a2a.ts `taskJson`: a completed Task with one text artifact.
const task: A2aTask = {
  id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  contextId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
  status: { state: "TASK_STATE_COMPLETED", timestamp: "2026-09-26T04:00:00.000Z" },
  artifacts: [{ artifactId: "answer", parts: [{ text: "42" }] }],
  history: [{ messageId: "task-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] }],
  metadata: { relay: { requester: { handle: "boss" } } },
};

// a2a.ts `runMethod` for an agent that does not accept tasks: SendMessage
// answers {message}, the agent's next message in the chat between the two
// agents, with that chat's id as contextId; its card's modes are MESSAGE_MODES.
const reply: A2aMessage = {
  messageId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3a",
  contextId: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a3b",
  role: "ROLE_AGENT",
  parts: [{ text: "I answer questions about Relay." }],
};
const messageCard = {
  ...card,
  defaultInputModes: ["text/plain", "application/a2ui+json"],
  defaultOutputModes: ["text/plain", "application/json", "application/a2ui+json"],
};

const a2aFixture = (
  baseURL = "https://api.staging.relayapp.im",
  answer: { card: object; sent: { task: A2aTask } | { message: A2aMessage } } = { card, sent: { task } },
) => {
  const calls: Captured[] = [];
  const client = new Relay({
    apiKey: "boss-agent-token",
    baseURL,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers: new Headers(init?.headers), body });
      if (method === "GET") return Response.json(answer.card);
      const rpc = body as { id: number; method: string };
      const result = rpc.method === "SendMessage" ? answer.sent : task;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  return { client, calls };
};

describe("tasks between agents", () => {
  it("sends a task over A2A 1.0 with the agent's Relay token as bearer", async () => {
    const { client, calls } = a2aFixture();
    const sent = await client.tasks.send({
      to: "@Worker",
      message: { messageId: "task-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] },
      configuration: { returnImmediately: true },
      metadata: { priority: "high" },
    });

    expect(sent).toEqual(task);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://staging.relayagent.im/worker/agent-card.json"],
      ["POST", "https://staging.relayagent.im/worker"],
    ]);
    const rpc = calls[1]!;
    expect(rpc.headers.get("authorization")).toBe("Bearer boss-agent-token");
    expect(rpc.headers.get("a2a-version")).toBe("1.0");
    expect(rpc.headers.get("content-type")).toBe("application/json");
    expect(rpc.body).toMatchObject({
      jsonrpc: "2.0",
      method: "SendMessage",
      params: {
        message: { messageId: "task-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] },
        configuration: { returnImmediately: true },
        metadata: { priority: "high" },
      },
    });
    // The Agent Card is public; the token goes only to the JSON-RPC call.
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("answers with the agent's Message when the agent does not accept tasks, as @a2a-js/sdk does", async () => {
    const { client, calls } = a2aFixture(undefined, { card: messageCard, sent: { message: reply } });
    const sent: A2aSendMessageResult = await client.tasks.send({
      to: "relay",
      message: { messageId: "hello-relay-1", role: "ROLE_USER", parts: [{ text: "What can you do?" }] },
    });

    expect(sent).toEqual(reply);
    if (!("messageId" in sent)) throw new Error("expected a Message");
    expect(sent.contextId).toBe(reply.contextId);
    expect(calls.map((call) => call.body && (call.body as { method: string }).method)).toEqual([
      undefined,
      "SendMessage",
    ]);
  });

  it("tells a Task from a Message by messageId", async () => {
    const { client } = a2aFixture();
    const sent = await client.tasks.send({
      to: "worker",
      message: { messageId: "task-2", role: "ROLE_USER", parts: [{ text: "Add 1 and 1." }] },
    });
    expect("messageId" in sent).toBe(false);
    if ("messageId" in sent) throw new Error("expected a Task");
    expect(sent.status.state).toBe("TASK_STATE_COMPLETED");
  });

  it("reads and cancels a task with GetTask and CancelTask at the same address, reusing the card", async () => {
    const { client, calls } = a2aFixture();
    expect(await client.tasks.get({ to: "worker", id: task.id, historyLength: 0 })).toEqual(task);
    expect(await client.tasks.cancel({ to: "worker", id: task.id })).toEqual(task);

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://staging.relayagent.im/worker/agent-card.json"],
      ["POST", "https://staging.relayagent.im/worker"],
      ["POST", "https://staging.relayagent.im/worker"],
    ]);
    expect(calls.slice(1).map((call) => call.body)).toMatchObject([
      { method: "GetTask", params: { id: task.id, historyLength: 0 } },
      { method: "CancelTask", params: { id: task.id } },
    ]);
    for (const call of calls.slice(1)) {
      expect(call.headers.get("authorization")).toBe("Bearer boss-agent-token");
      expect(call.headers.get("a2a-version")).toBe("1.0");
    }
  });

  it.each([
    ["https://api.relayapp.im", "https://relayagent.im/worker/agent-card.json"],
    ["https://api.staging.relayapp.im/", "https://staging.relayagent.im/worker/agent-card.json"],
    ["http://127.0.0.1:8788", "http://127.0.0.1:8788/a2a/worker/agent-card.json"],
  ])("finds agents' A2A addresses for %s", async (baseURL, cardURL) => {
    const { client, calls } = a2aFixture(baseURL);
    await client.tasks.get({ to: "worker", id: task.id });
    expect(calls[0]!.url).toBe(cardURL);
  });

  it("types task.created as a Task event", () => {
    const event: RelayWebhookEvent = {
      api_version: "v1",
      webhook_version: "2026-08-30",
      event_type: "task.created",
      event_id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d",
      created_at: "2026-09-26T04:00:00.000Z",
      trace_id: "trace",
      agent_id: "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2e",
      data: { task },
    } satisfies TaskCreatedWebhookEvent;
    if (event.event_type === "task.created") {
      expect(event.data.task.status.state).toBe("TASK_STATE_COMPLETED");
    }
  });

  it("loads the A2A client only when a task call is made", () => {
    // A child Node process records every @a2a-js/* module it resolves while
    // it loads the built SDK, makes a client, and then calls tasks.get.
    const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
    const script = `
      import { registerHooks } from "node:module";
      const seen = [];
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith("@a2a-js/")) seen.push(specifier);
        return next(specifier, context);
      } });
      const { default: Relay } = await import(${JSON.stringify(entry)});
      const card = ${JSON.stringify(card)};
      const task = ${JSON.stringify(task)};
      const relay = new Relay({ apiKey: "t", baseURL: "https://api.staging.relayapp.im",
        fetch: async (input, init) => init?.method === "POST"
          ? Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: task })
          : Response.json(card) });
      const before = [...seen];
      await relay.tasks.get({ to: "worker", id: task.id });
      console.log(JSON.stringify({ before, after: [...new Set(seen)].sort() }));
    `;
    const out = execFileSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8" });
    expect(JSON.parse(out)).toEqual({ before: [], after: ["@a2a-js/sdk", "@a2a-js/sdk/client"] });
  });
});
