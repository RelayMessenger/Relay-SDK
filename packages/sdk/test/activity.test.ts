import { describe, expect, it } from "vitest";
import Relay, {
  RELAY_WEBHOOK_EVENT_TYPES,
  type ChatActivityResponse,
  type ChatHandle,
  type ChatSetActivityParams,
} from "../src/index.js";

const state: ChatActivityResponse = {
  chat_id: "01995bc0-0000-7000-8000-000000000001",
  agent_id: "01995bc0-0000-7000-8000-000000000002",
  version: "9007199254740993",
  activity: {
    id: "01995bc0-0000-7000-8000-000000000003",
    text: "Generating image",
    emoji: "🖼️",
    updated_at: "2026-09-20T12:00:00Z",
    expires_at: "2026-09-20T12:01:30Z",
  },
};

function fixture(response = state, status = 200) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const client = new Relay({
    apiKey: "activity-test-token",
    baseURL: "https://api.staging.relayapp.im",
    retryBaseDelayMs: 0,
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), init: init! });
      return status === 204 ? new Response(null, { status }) : Response.json(response, { status });
    },
  });
  return { client, requests };
}

describe("Chat activity", () => {
  it.each([state, { ...state, activity: null }])("reads own state without losing the string version", async (response) => {
    const { client, requests } = fixture(response);
    expect(await client.chats.getActivity("chat/one")).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/v1/chats/chat%2Fone/activity");
    expect(requests[0]!.url.search).toBe("");
    expect(requests[0]!.init.method).toBe("GET");
    expect(requests[0]!.init.body).toBeUndefined();
  });

  it.each([
    { text: "Generating image" },
    { text: "Generating image", emoji: "🖼️" },
    { text: "Generating voice note", emoji: "🎙️", activity_id: state.activity!.id },
    { text: "Working", emoji: null, activity_id: state.activity!.id },
  ] satisfies ChatSetActivityParams[])("sends the exact start or refresh body: %j", async (body) => {
    const { client, requests } = fixture();
    expect(await client.chats.setActivity("chat/one", body)).toEqual(state);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/v1/chats/chat%2Fone/activity");
    expect(requests[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual(body);
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer activity-test-token");
  });

  it.each([{}, { activity_id: state.activity!.id }])("clears with an optional query guard, not a body: %j", async (query) => {
    const { client, requests } = fixture(state, 204);
    expect(await client.chats.clearActivity("chat/one", query)).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/v1/chats/chat%2Fone/activity");
    expect(Object.fromEntries(requests[0]!.url.searchParams)).toEqual(query);
    expect(requests[0]!.init.method).toBe("DELETE");
    expect(requests[0]!.init.body).toBeUndefined();
  });

  it("allows unguarded cleanup with omitted params", async () => {
    const { client, requests } = fixture(state, 204);
    await client.chats.clearActivity("chat");
    expect(requests[0]!.url.search).toBe("");
  });

  it("surfaces stale refresh conflicts without retrying or replacing the task", async () => {
    let attempts = 0;
    const client = new Relay({
      apiKey: "token",
      retryBaseDelayMs: 0,
      fetch: async () => {
        attempts += 1;
        return Response.json({ error: { message: "Activity is stale", status: 409 } }, { status: 409 });
      },
    });
    await expect(client.chats.setActivity("chat", {
      text: "Working", activity_id: state.activity!.id,
    })).rejects.toMatchObject({ status: 409 });
    expect(attempts).toBe(1);
  });

  it.each(["get", "set", "clear"] as const)("forwards request options for %s", async (method) => {
    const { client, requests } = fixture(state, method === "clear" ? 204 : 200);
    const options = { headers: { "x-test-option": "activity" }, maxRetries: 0 };
    if (method === "get") await client.chats.getActivity("chat", options);
    if (method === "set") await client.chats.setActivity("chat", { text: "Working" }, options);
    if (method === "clear") await client.chats.clearActivity("chat", {}, options);
    expect(new Headers(requests[0]!.init.headers).get("x-test-option")).toBe("activity");
  });

  it("carries optional activity state on either kind of Chat handle without adding an agent event", () => {
    const handles: ChatHandle[] = (["agent", "user"] as const).map((kind) => ({
      id: state.agent_id, kind, handle: "fixture", joined_at: "2026-09-20T12:00:00Z",
      display_name: null, image_url: null, about: null, verified: false, is_contact: true,
      activity_version: state.version, activity: kind === "agent" ? state.activity : null,
    }));
    expect(handles[0]!.activity).toEqual(state.activity);
    expect(handles[1]!.activity).toBeNull();
    expect(RELAY_WEBHOOK_EVENT_TYPES).not.toContain("chat.activity.updated");
  });
});
