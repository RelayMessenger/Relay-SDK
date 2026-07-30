import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertRelayStateDocument,
  emptyRelayStateDocument,
  openRelayStateDocument,
} from "./state-files.js";

function stateFixture(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `relay-state-${label}-`));
  const store = openRelayStateDocument<number>({
    fileName: "fixture.json",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    lockTimeoutMs: 100,
  });
  return { stateDir, store };
}

describe("Relay-owned state files", () => {
  it("creates private parents and atomically writes a private document", async () => {
    const { stateDir, store } = stateFixture("permissions");
    try {
      await store.write({ version: 1, entries: { one: 1 } });
      expect(JSON.parse(readFileSync(store.filePath, "utf8"))).toEqual({
        version: 1,
        entries: { one: 1 },
      });
      if (process.platform !== "win32") {
        expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(store.filePath)).mode & 0o777).toBe(0o700);
        expect(statSync(dirname(dirname(store.filePath))).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent updates from separate store handles", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "relay-state-concurrency-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const first = openRelayStateDocument<number>({ fileName: "counter.json", env });
    const second = openRelayStateDocument<number>({ fileName: "counter.json", env });
    try {
      await Promise.all(
        Array.from({ length: 40 }, (_, index) => {
          const store = index % 2 === 0 ? first : second;
          return store.updateOr(emptyRelayStateDocument<number>(), async (current) => {
            await new Promise((resolve) => setTimeout(resolve, index % 3));
            return {
              version: current.version,
              entries: { count: (current.entries.count ?? 0) + 1 },
            };
          });
        }),
      );
      expect((await first.readRequired()).entries.count).toBe(40);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers only a valid local Relay lock whose process is dead", async () => {
    const { stateDir, store } = stateFixture("dead-lock");
    try {
      mkdirSync(dirname(store.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        `${store.filePath}.lock`,
        `${JSON.stringify({
          version: 1,
          kind: "relay-state",
          pid: 2_147_483_647,
          host: hostname(),
          createdAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );
      await expect(store.write({ version: 1, entries: { recovered: 1 } })).resolves.toBeUndefined();
      expect((await store.readRequired()).entries.recovered).toBe(1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed instead of deleting a malformed or live-owner lock", async () => {
    for (const [label, payload] of [
      ["malformed", "{not-json"],
      [
        "live",
        JSON.stringify({
          version: 1,
          kind: "relay-state",
          pid: process.pid,
          host: hostname(),
          createdAt: new Date().toISOString(),
        }),
      ],
    ] as const) {
      const { stateDir, store } = stateFixture(label);
      try {
        mkdirSync(dirname(store.filePath), { recursive: true, mode: 0o700 });
        writeFileSync(`${store.filePath}.lock`, `${payload}\n`, { mode: 0o600 });
        await expect(
          store.write({ version: 1, entries: { unsafe: 1 } }),
        ).rejects.toThrow(/file lock timeout/u);
        expect(readFileSync(`${store.filePath}.lock`, "utf8")).toBe(`${payload}\n`);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    }
  });

  it("rejects structurally corrupt documents without mutating them", async () => {
    const { stateDir, store } = stateFixture("corrupt");
    try {
      mkdirSync(dirname(store.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(store.filePath, '{"version":1,"entries":{"bad":"value"}}\n', { mode: 0o600 });
      chmodSync(store.filePath, 0o600);
      const before = readFileSync(store.filePath, "utf8");
      const current = await store.readRequired();
      expect(() =>
        assertRelayStateDocument(
          current,
          "test",
          (_key, value): value is number => typeof value === "number",
        ),
      ).toThrow(/state is corrupt/u);
      expect(readFileSync(store.filePath, "utf8")).toBe(before);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal and invalid lock bounds before touching disk", () => {
    expect(() => openRelayStateDocument({ fileName: "../escape.json" })).toThrow(/fileName/u);
    expect(() =>
      openRelayStateDocument({ fileName: "valid.json", lockTimeoutMs: 0 }),
    ).toThrow(/lockTimeoutMs/u);
  });
});
