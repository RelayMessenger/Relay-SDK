import { describe, expect, it } from "vitest";
import Relay, {
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
  description: "Does jobs",
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
  history: [{ messageId: "job-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] }],
  metadata: { relay: { requester: { handle: "boss" } } },
};

const a2aFixture = (baseURL = "https://api.staging.relayapp.im") => {
  const calls: Captured[] = [];
  const client = new Relay({
    apiKey: "boss-agent-token",
    baseURL,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, headers: new Headers(init?.headers), body });
      if (method === "GET") return Response.json(card);
      const rpc = body as { id: number; method: string };
      const result = rpc.method === "SendMessage" ? { task } : task;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  return { client, calls };
};

describe("jobs between agents", () => {
  it("sends a job over A2A 1.0 with the agent's Relay token as bearer", async () => {
    const { client, calls } = a2aFixture();
    const sent = await client.tasks.send({
      to: "@Worker",
      message: { messageId: "job-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] },
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
        message: { messageId: "job-1", role: "ROLE_USER", parts: [{ text: "Add 40 and 2." }] },
        configuration: { returnImmediately: true },
        metadata: { priority: "high" },
      },
    });
    // The Agent Card is public; the token goes only to the JSON-RPC call.
    expect(calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("reads and cancels a job with GetTask and CancelTask at the same address, reusing the card", async () => {
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
});
