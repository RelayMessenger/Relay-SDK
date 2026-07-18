import { describe, expect, it } from "vitest";
import { createRelayCursorStore } from "./cursor-store.js";
import type { RelayCursorRecord, RelayCursorStateStore } from "./cursor-store.js";

function memoryStore(initial?: Record<string, RelayCursorRecord>) {
  const map = new Map<string, RelayCursorRecord>(Object.entries(initial ?? {}));
  const calls: string[] = [];
  const store: RelayCursorStateStore = {
    lookup: async (key) => {
      calls.push(`lookup:${key}`);
      return map.get(key);
    },
    register: async (key, value) => {
      calls.push(`register:${key}:${value.cursor}`);
      map.set(key, value);
    },
    delete: async (key) => {
      calls.push(`delete:${key}`);
      return map.delete(key);
    },
  };
  return { store, map, calls };
}

describe("relay cursor store", () => {
  const baseUrl = "https://api.relayapp.im";
  const key = "relay:https://api.relayapp.im:agt_1";

  it("starts at 0 with no persisted record", async () => {
    const { store } = memoryStore();
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    expect(await cursor.load()).toBe(0);
    expect(cursor.current()).toBe(0);
  });

  it("persists monotonic advances and reloads them", async () => {
    const { store, map } = memoryStore();
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await cursor.load();
    await cursor.advance(5);
    await cursor.advance(9);
    expect(cursor.current()).toBe(9);
    expect(map.get(key)?.cursor).toBe(9);

    const reloaded = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    expect(await reloaded.load()).toBe(9);
  });

  it("ignores non-monotonic and invalid advances", async () => {
    const { store, map } = memoryStore();
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await cursor.load();
    await cursor.advance(10);
    await cursor.advance(10); // equal: no-op
    await cursor.advance(3); // backwards: no-op
    await cursor.advance(-1); // invalid
    await cursor.advance(2.5); // invalid
    expect(cursor.current()).toBe(10);
    expect(map.get(key)?.cursor).toBe(10);
  });

  it("requires load() before advance() so ack ordering cannot be skipped", async () => {
    const { store } = memoryStore();
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await expect(cursor.advance(4)).rejects.toThrow(/before load/);
  });

  it("fails closed on a mismatched or corrupt stable-identity record", async () => {
    const { store } = memoryStore({
      [key]: { version: 2, cursor: 42, baseUrl, agentId: "agt_old" },
    });
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await expect(cursor.load()).rejects.toThrow(/refusing cursor-zero replay/);
  });

  it("fails closed on wrong-version records", async () => {
    const { store } = memoryStore({
      [key]: { version: 99, cursor: 42, baseUrl, agentId: "agt_1" },
    });
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await expect(cursor.load()).rejects.toThrow(/refusing cursor-zero replay/);
  });

  it("fails closed without advancing memory when persistence fails", async () => {
    const errors: unknown[] = [];
    const store: RelayCursorStateStore = {
      lookup: async () => undefined,
      register: async () => {
        throw new Error("disk broken");
      },
      delete: async () => false,
    };
    const cursor = createRelayCursorStore({
      store,
      baseUrl,
      agentId: "agt_1",
      onPersistError: (error) => errors.push(error),
    });
    await cursor.load();
    await expect(cursor.advance(7)).rejects.toThrow(/was not durable/);
    expect(cursor.current()).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("survives account rename and scopes records by canonical origin plus agent", async () => {
    const { store, map } = memoryStore();
    const a = createRelayCursorStore({ store, baseUrl: `${baseUrl}/`, agentId: "agt_1" });
    const renamed = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    const b = createRelayCursorStore({ store, baseUrl, agentId: "agt_2" });
    await a.load();
    await a.advance(3);
    expect(await renamed.load()).toBe(3);
    await b.load();
    await b.advance(8);
    expect(map.get(key)?.cursor).toBe(3);
    expect(map.get("relay:https://api.relayapp.im:agt_2")?.cursor).toBe(8);
  });

  it("retains an ack beyond the bounded dedupe horizon", async () => {
    const { store } = memoryStore();
    const cursor = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    await cursor.load();
    await cursor.advance(25_001);
    const afterDedupeEviction = createRelayCursorStore({ store, baseUrl, agentId: "agt_1" });
    expect(await afterDedupeEviction.load()).toBe(25_001);
  });

  it("fails closed when cursor state lookup is unavailable", async () => {
    const cursor = createRelayCursorStore({
      baseUrl,
      agentId: "agt_1",
      store: {
        lookup: async () => { throw new Error("sqlite unavailable"); },
        register: async () => {},
        delete: async () => false,
      },
    });
    await expect(cursor.load()).rejects.toThrow(/could not be loaded/);
  });
});
