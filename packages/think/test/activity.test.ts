import Relay from "@relaymessenger/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVITY_REFRESH_MS, RelayGenerationActivities } from "../src/activity";
import { ActivityServer, deferred } from "./activity-fixture";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";

function client() {
  return new Relay({
    apiKey: "test-token",
    baseURL: "https://api.staging.relayapp.im",
  }).chats;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Status words the model wrote in its send Action. */
const IMAGE = { text: "Drawing your cat", emoji: "🐱" };
const VOICE = { text: "Recording a note", emoji: null };

describe("generation-owned activity", () => {
  it.each([
    ["an image", "Drawing your cat", "🐱"],
    ["a voice memo", "Recording a note", null],
  ] as const)("starts %s's status in the model's words and renews the same task every 60s", async (_what, text, emoji) => {
    vi.useFakeTimers();
    const server = new ActivityServer();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      return server.respond(String(url), init)!;
    }));
    const task = new RelayGenerationActivities().start(client(), CHAT_ID, { text, emoji }, () => {});
    expect(server.calls).toEqual([{ method: "PUT", id: null, body: { text, emoji } }]);
    const id = server.activity!.id;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS - 1);
    expect(server.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls[1]).toEqual({
      method: "PUT", id, body: { text, emoji, activity_id: id },
    });
    expect(server.activity).toMatchObject({ id, text, emoji });
    const stopping = task.stop();
    expect(task.stop()).toBe(stopping);
    await stopping;
    expect(server.calls[2]).toEqual({ method: "DELETE", id });
    expect(server.activity).toBeNull();
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(server.calls).toHaveLength(3);
  });

  it("an old completion and heartbeat cannot clear or recreate a newer task", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new ActivityServer();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => server.respond(String(url), init)!));
    const activities = new RelayGenerationActivities();
    const chats = client();
    const old = activities.start(chats, CHAT_ID, IMAGE, () => {});
    const oldId = server.activity!.id;
    await vi.advanceTimersByTimeAsync(0);
    const newer = activities.start(chats, CHAT_ID, VOICE, () => {});
    await vi.advanceTimersByTimeAsync(0);
    const newId = server.activity!.id;
    expect(newId).not.toBe(oldId);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    expect(server.calls.filter((call) => call.id === oldId && call.method === "PUT")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    // Old renewal received 409, so it stopped instead of starting again.
    expect(server.calls.filter((call) => call.id === oldId && call.method === "PUT")).toHaveLength(1);
    await old.stop();
    expect(server.activity).toMatchObject({ id: newId, text: VOICE.text });
    await newer.stop();
    expect(server.activity).toBeNull();
    expect(server.calls.filter((call) => call.method === "PUT" && call.id === null)).toHaveLength(2);
  });

  it("orders overlapping initial writes and clears a late response only by its returned ID", async () => {
    vi.useFakeTimers();
    const server = new ActivityServer();
    const gate = deferred<void>();
    let starts = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "PUT" && ++starts === 1) await gate.promise;
      return server.respond(String(url), init)!;
    }));
    const activities = new RelayGenerationActivities();
    const chats = client();
    const old = activities.start(chats, CHAT_ID, IMAGE, () => {});
    const stopping = old.stop();
    const newer = activities.start(chats, CHAT_ID, VOICE, () => {});
    expect(starts).toBe(1);
    gate.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(2);
    expect(server.calls.filter((call) => call.method === "PUT").map((call) => call.body?.text))
      .toEqual([IMAGE.text, VOICE.text]);
    expect(server.activity?.text).toBe(VOICE.text);
    const oldId = server.calls.find((call) => call.method === "DELETE")!.id;
    expect(oldId).toBeTruthy();
    expect(oldId).not.toBe(server.activity!.id);
    await newer.stop();
  });

  it("does not dispatch a queued start after its operation has already ended", async () => {
    const server = new ActivityServer();
    const gate = deferred<void>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "PUT") await gate.promise;
      return server.respond(String(url), init)!;
    }));
    const activities = new RelayGenerationActivities();
    const chats = client();
    const old = activities.start(chats, CHAT_ID, IMAGE, () => {});
    const canceled = activities.start(chats, CHAT_ID, VOICE, () => {});
    const stopping = canceled.stop();
    gate.resolve();
    await stopping;
    expect(server.calls).toHaveLength(1);
    await old.stop();
  });

  it("rechecks supersession before dispatching a queued start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new ActivityServer();
    const gate = deferred<void>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "PUT") await gate.promise;
      return server.respond(String(url), init)!;
    }));
    const activities = new RelayGenerationActivities();
    const chats = client();
    const old = activities.start(chats, CHAT_ID, IMAGE, () => {});
    let current = true;
    const newer = activities.start(chats, CHAT_ID, VOICE, () => {
      if (!current) throw new DOMException("superseded", "AbortError");
    });
    current = false;
    gate.resolve();
    await old.stop();
    await newer.stop();
    expect(server.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("waits for an in-flight renewal before clearing and never renews after stop", async () => {
    vi.useFakeTimers();
    const server = new ActivityServer();
    const renewing = deferred<void>();
    const gate = deferred<void>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "PUT" && String(init.body).includes("activity_id")) {
        renewing.resolve();
        await gate.promise;
      }
      return server.respond(String(url), init)!;
    }));
    const task = new RelayGenerationActivities().start(client(), CHAT_ID, IMAGE, () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS);
    await renewing.promise;
    const stopping = task.stop();
    expect(server.calls.some((call) => call.method === "DELETE")).toBe(false);
    gate.resolve();
    await stopping;
    expect(server.calls.map((call) => call.method)).toEqual(["PUT", "PUT", "DELETE"]);
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(server.calls).toHaveLength(3);
  });

  it("never retries an ambiguous start or clears an unknown ID", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("network lost"); });
    vi.stubGlobal("fetch", fetcher);
    const task = new RelayGenerationActivities().start(client(), CHAT_ID, IMAGE, () => {});
    await task.stop();
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("tolerates a failed guarded clear without restarting its heartbeat", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = new ActivityServer();
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "DELETE") throw new TypeError("network lost");
      return server.respond(String(url), init)!;
    });
    vi.stubGlobal("fetch", fetcher);
    const task = new RelayGenerationActivities().start(client(), CHAT_ID, IMAGE, () => {});
    await task.stop();
    await task.stop();
    await vi.advanceTimersByTimeAsync(ACTIVITY_REFRESH_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps its registered lifetime open until guarded cleanup has finished", async () => {
    const server = new ActivityServer();
    const gate = deferred<void>();
    const clearing = deferred<void>();
    const tasks: Promise<void>[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "DELETE") {
        clearing.resolve();
        await gate.promise;
      }
      return server.respond(String(url), init)!;
    }));
    const task = new RelayGenerationActivities().start(
      client(), CHAT_ID, IMAGE, () => {}, (pending) => { tasks.push(pending); },
    );
    expect(tasks).toHaveLength(1);
    let finished = false;
    const lifetime = tasks[0]!.then(() => { finished = true; });
    const stopping = task.stop();
    await clearing.promise;
    expect(finished).toBe(false);
    gate.resolve();
    await stopping;
    await lifetime;
    expect(finished).toBe(true);
  });
});
