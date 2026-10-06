import { encodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RELAY_ACTION_NAMES, relayActions, type RelayActionsAgent } from "../src/actions";

// @cloudflare/think loads cloudflare:workers, which exists only in a Worker.
// action() wraps its config; these tests call the config's execute.
vi.mock("@cloudflare/think", () => ({ action: (config: unknown) => ({ config }) }));

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const MESSAGE_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec11";
const PAYMENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec14";

interface Wired {
  config: {
    description: string;
    inputSchema: { parse(value: unknown): unknown };
    execute(input: unknown, context: { signal?: AbortSignal }): Promise<unknown>;
  };
}

function agent(): RelayActionsAgent {
  return {
    env: { RELAY_AGENT_TOKEN: "relay-test-token", RELAY_API_ORIGIN: "https://api.example.test" },
    getMessengerContext: () => ({
      thread: { providerThreadId: encodeRelayThreadId({ chatId: CHAT_ID }) },
      message: { id: `relay:${MESSAGE_ID}`, providerMessageId: MESSAGE_ID },
    }),
  };
}

/** Records each request and answers with the body `respond` picks. */
function relayServer(respond: (url: string, method: string) => Response) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, ...(typeof init.body === "string" ? { body: init.body } : {}) });
    return respond(url, method);
  }));
  return calls;
}

async function run(name: string, input: unknown = {}): Promise<unknown> {
  const wired = relayActions(agent())[name] as unknown as Wired;
  return await wired.config.execute(wired.config.inputSchema.parse(input), {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayActions", () => {
  it("offers every Relay Action in one call", () => {
    expect(Object.keys(relayActions(agent())).sort()).toEqual([...RELAY_ACTION_NAMES].sort());
  });

  it("leaves out the Actions the agent disables, and keeps the rest", () => {
    const actions = relayActions(agent(), { disable: ["start_call", "group"] });
    expect(actions.start_call).toBeUndefined();
    expect(actions.group).toBeUndefined();
    expect(Object.keys(actions)).toHaveLength(RELAY_ACTION_NAMES.length - 2);
  });

  it("leaves the agent's own tools to a spread beside them", () => {
    const own = { lookup_order: relayActions(agent()).stay_silent! };
    expect(Object.keys({ ...relayActions(agent()), ...own })).toContain("lookup_order");
  });

  it("offers image and voice_memo only when the agent gives its own media models", () => {
    const kinds = (actions: ReturnType<typeof relayActions>) => {
      const schema = (actions.send as unknown as Wired).config.inputSchema;
      return ["image", "voice_memo"].filter((kind) => {
        try {
          schema.parse(kind === "image" ? { kind, prompt: "a cat" } : { kind, text: "hi" });
          return true;
        } catch {
          return false;
        }
      });
    };
    expect(kinds(relayActions(agent()))).toEqual([]);
    expect(kinds(relayActions(agent(), {
      media: { image: async () => ({ bytes: new Uint8Array(1), contentType: "image/png" }) },
    }))).toEqual(["image"]);
    expect((relayActions(agent()).send as unknown as Wired).config.description).not.toContain("voice_memo");
  });

  it("reads the turn's Chat and Message from Think's messenger context", async () => {
    const calls = relayServer(() => Response.json({ chat_id: CHAT_ID, message: { id: "sent" } }));
    await run("send", { kind: "text", text: "hi", reply: true });
    expect(calls[0]!.url).toBe(`https://api.example.test/v1/chats/${CHAT_ID}/messages`);
    expect(JSON.parse(calls[0]!.body!).message).toMatchObject({
      idempotency_key: `relay-agent:${MESSAGE_ID}`,
      reply_to: { message_id: MESSAGE_ID, part_index: 0 },
    });
  });

  it("react reacts to the turn's Message", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("react", { type: "love" })).resolves.toEqual({ status: "reacted", type: "love" });
    expect(calls[0]!.url).toBe(`https://api.example.test/v1/messages/${MESSAGE_ID}/reactions`);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ operation: "add", type: "love" });
  });

  it("request_location asks this Chat's person to share", async () => {
    const calls = relayServer(() => new Response(null, { status: 204 }));
    await expect(run("request_location")).resolves.toEqual({ status: "requested" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/location`);
  });

  it("read_location reads this Chat's shares", async () => {
    const calls = relayServer(() => Response.json({ data: { type: "FeatureCollection", features: [] } }));
    await expect(run("read_location")).resolves.toEqual({ status: "not_sharing" });
    expect(calls[0]).toMatchObject({ method: "GET" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/location`);
  });

  it("start_call refuses a group without ringing anyone", async () => {
    const calls = relayServer(() => Response.json({ id: CHAT_ID, is_group: true, handles: [] }));
    await expect(run("start_call")).resolves.toMatchObject({ status: "not_called" });
    expect(calls.map(({ url, method }) => `${method} ${url}`)).toEqual([
      `GET https://api.example.test/v1/chats/${CHAT_ID}`,
    ]);
  });

  it("find_agents looks agents up by task", async () => {
    const calls = relayServer(() => Response.json({ contacts: [] }));
    await expect(run("find_agents", { task: "plan a trip" })).resolves.toEqual({ status: "found", contacts: [] });
    expect(calls[0]!.url).toContain("/v1/contacts/");
    expect(decodeURIComponent(calls[0]!.url + (calls[0]!.body ?? ""))).toContain("plan a trip");
  });

  it("payment_request reads a request by its id", async () => {
    const calls = relayServer(() => Response.json({ error: { message: "No such payment request" } }, { status: 404 }));
    await expect(run("payment_request", { do: "status", payment_request_id: PAYMENT_ID })).resolves.toMatchObject({
      status: "not_found",
    });
    expect(calls[0]!.url).toContain(`/v1/payment_requests/${PAYMENT_ID}`);
  });

  it("group refuses to change a one-to-one Chat", async () => {
    const calls = relayServer(() => Response.json({ id: CHAT_ID, is_group: false, handles: [] }));
    await expect(run("group", { do: "rename", name: "Trip" })).resolves.toMatchObject({ status: "not_done" });
    expect(calls).toHaveLength(1);
  });

  it("share_contact_card shares the agent's card into this Chat", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("share_contact_card")).resolves.toEqual({ status: "done" });
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0]!.url).toContain(`/v1/chats/${CHAT_ID}/`);
  });

  it("stay_silent sends nothing", async () => {
    const calls = relayServer(() => Response.json({}));
    await expect(run("stay_silent")).resolves.toEqual({ status: "silent" });
    expect(calls).toHaveLength(0);
  });
});
