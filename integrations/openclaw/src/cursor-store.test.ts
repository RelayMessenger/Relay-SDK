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
  it("starts at 0 with no persisted record", async () => {
    const { store } = memoryStore();
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    expect(await cursor.load()).toBe(0);
    expect(cursor.current()).toBe(0);
  });

  it("persists monotonic advances and reloads them", async () => {
    const { store, map } = memoryStore();
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    await cursor.load();
    await cursor.advance(5);
    await cursor.advance(9);
    expect(cursor.current()).toBe(9);
    expect(map.get("default")?.cursor).toBe(9);

    const reloaded = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    expect(await reloaded.load()).toBe(9);
  });

  it("ignores non-monotonic and invalid advances", async () => {
    const { store, map } = memoryStore();
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    await cursor.load();
    await cursor.advance(10);
    await cursor.advance(10); // equal: no-op
    await cursor.advance(3); // backwards: no-op
    await cursor.advance(-1); // invalid
    await cursor.advance(2.5); // invalid
    expect(cursor.current()).toBe(10);
    expect(map.get("default")?.cursor).toBe(10);
  });

  it("requires load() before advance() so ack ordering cannot be skipped", async () => {
    const { store } = memoryStore();
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    await expect(cursor.advance(4)).rejects.toThrow(/before load/);
  });

  it("discards the persisted cursor when the token now maps to another agent", async () => {
    const { store, calls } = memoryStore({
      default: { version: 1, cursor: 42, agentId: "agt_old" },
    });
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_new" });
    expect(await cursor.load()).toBe(0);
    expect(calls).toContain("delete:default");
  });

  it("discards corrupt or wrong-version records", async () => {
    const { store } = memoryStore({
      default: { version: 99, cursor: 42, agentId: "agt_1" },
    });
    const cursor = createRelayCursorStore({ store, accountId: "default", agentId: "agt_1" });
    expect(await cursor.load()).toBe(0);
  });

  it("keeps the in-memory cursor when persistence fails", async () => {
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
      accountId: "default",
      agentId: "agt_1",
      onPersistError: (error) => errors.push(error),
    });
    await cursor.load();
    await cursor.advance(7);
    expect(cursor.current()).toBe(7);
    expect(errors).toHaveLength(1);
  });

  it("scopes records per account id", async () => {
    const { store, map } = memoryStore();
    const a = createRelayCursorStore({ store, accountId: "a", agentId: "agt_1" });
    const b = createRelayCursorStore({ store, accountId: "b", agentId: "agt_2" });
    await a.load();
    await b.load();
    await a.advance(3);
    await b.advance(8);
    expect(map.get("a")?.cursor).toBe(3);
    expect(map.get("b")?.cursor).toBe(8);
  });
});
