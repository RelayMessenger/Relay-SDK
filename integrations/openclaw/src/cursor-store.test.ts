import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRelayCursorStore, openRelayCursorStateStore } from "./cursor-store.js";
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

  it("fails closed when cursor state lookup is unavailable", async () => {
    const cursor = createRelayCursorStore({
      baseUrl,
      agentId: "agt_1",
      store: {
        lookup: async () => { throw new Error("sqlite unavailable"); },
        register: async () => {},
      },
    });
    await expect(cursor.load()).rejects.toThrow(/could not be loaded/);
  });

  it("fails closed on corrupt Relay-owned cursor state without overwriting it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-cursor-corrupt-"));
    const warnings: string[] = [];
    try {
      const store = openRelayCursorStateStore((line) => warnings.push(line), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const filePath = join(stateDir, "relay", "state", "cursors.json");
      const corrupt = '{"version":1,"entries":{"not-a-hash":{"cursor":4}}}\n';
      writeFileSync(filePath, corrupt, { mode: 0o600 });
      await expect(store.lookup("relay:https://api.relayapp.im:agt_1")).rejects.toThrow(
        /state is corrupt/u,
      );
      expect(warnings.join("\n")).toMatch(/refusing unsafe cursor reset/u);
      expect(readFileSync(filePath, "utf8")).toBe(corrupt);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects a new identity at capacity without evicting an old durable cursor", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-cursor-capacity-"));
    try {
      const store = openRelayCursorStateStore(() => {}, {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        maxEntries: 2,
      });
      const first = createRelayCursorStore({ store, baseUrl, agentId: "agt_capacity_1" });
      const second = createRelayCursorStore({ store, baseUrl, agentId: "agt_capacity_2" });
      const rejected = createRelayCursorStore({ store, baseUrl, agentId: "agt_capacity_3" });
      await first.load();
      await first.advance(101);
      await second.load();
      await second.advance(202);
      await rejected.load();
      await expect(rejected.advance(303)).rejects.toThrow(/was not durable/);

      const reloaded = createRelayCursorStore({ store, baseUrl, agentId: "agt_capacity_1" });
      expect(await reloaded.load()).toBe(101);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid capacity before opening durable state", () => {
    expect(() => openRelayCursorStateStore(() => {}, { maxEntries: 0 })).toThrow(/maxEntries/u);
  });
});
