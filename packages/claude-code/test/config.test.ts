import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConsumerLock,
  loadConfig,
  normalizeRelayBaseURL,
  parseAllowedSenders,
  parseEnvFile,
  senderIsAllowed,
} from "../src/config.ts";
import { createRedactor } from "../src/redaction.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Relay channel configuration", () => {
  it("accepts only HTTPS origins or loopback HTTP origins", () => {
    expect(normalizeRelayBaseURL("https://api.relayapp.im")).toBe("https://api.relayapp.im");
    expect(normalizeRelayBaseURL("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
    expect(() => normalizeRelayBaseURL("http://relay.example")).toThrow(/HTTPS/u);
    expect(() => normalizeRelayBaseURL("https://relay.example/v1")).toThrow(/origin/u);
    expect(() => normalizeRelayBaseURL("https://token@relay.example")).toThrow(/credentials/u);
  });

  it("parses strict allowed sender ids and exact handles", () => {
    const uuid = "00000000-0000-7000-8000-000000000001";
    const allowed = parseAllowedSenders(`${uuid},@Owner, @Owner`);
    expect(allowed.configured).toEqual([uuid, "@Owner"]);
    expect(senderIsAllowed(allowed, { id: uuid, handle: "@different", kind: "user" })).toBe(true);
    expect(senderIsAllowed(allowed, { id: "other", handle: "@Owner", kind: "user" })).toBe(true);
    expect(senderIsAllowed(allowed, { id: uuid, handle: "@Owner", kind: "agent" })).toBe(false);
    expect(senderIsAllowed(allowed, { id: "other", handle: "@owner", kind: "user" })).toBe(false);
  });

  it("loads owner-only .env fallback while real environment wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-config-"));
    cleanups.push(dir);
    writeFileSync(
      join(dir, ".env"),
      [
        "RELAY_AGENT_TOKEN=rly_file_abcdefghijklmnop",
        "RELAY_ALLOWED_SENDERS=@file-owner",
        "RELAY_BASE_URL=https://file.example",
      ].join("\n"),
      { mode: 0o600 },
    );
    const config = loadConfig({
      RELAY_CHANNEL_DIR: dir,
      RELAY_BASE_URL: "https://env.example",
      PWD: "/workspace/project",
    });
    expect(config.agentToken).toBe("rly_file_abcdefghijklmnop");
    expect(config.baseURL).toBe("https://env.example");
    expect(config.allowedSenders.handles.has("@file-owner")).toBe(true);
    expect(config.accountKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(config.stateDir).not.toContain(config.agentToken);
  });

  it("ignores unresolved Claude user_config placeholders", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-placeholder-"));
    cleanups.push(dir);
    writeFileSync(
      join(dir, ".env"),
      "RELAY_AGENT_TOKEN=rly_file_abcdefghijklmnop\nRELAY_ALLOWED_SENDERS=@owner\n",
      { mode: 0o600 },
    );
    const config = loadConfig({
      RELAY_CHANNEL_DIR: dir,
      RELAY_AGENT_TOKEN: "${user_config.agent_token}",
      RELAY_ALLOWED_SENDERS: "${user_config.allowed_senders}",
    });
    expect(config.agentToken).toBe("rly_file_abcdefghijklmnop");
    expect(config.allowedSenders.handles.has("@owner")).toBe(true);
  });

  it("parses quoted dotenv values without expansion", () => {
    expect(parseEnvFile("A='one two'\nexport B=three\n# C=no\n")).toEqual({
      A: "one two",
      B: "three",
    });
  });

  it("fails closed on an unreadable consumer lock instead of stealing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-lock-"));
    cleanups.push(dir);
    writeFileSync(join(dir, "consumer.lock"), "not-json\n", { mode: 0o600 });
    expect(() => new ConsumerLock(dir)).toThrow(/unreadable/u);
  });
});

describe("token redaction", () => {
  it("redacts the configured token and recognizable Relay token strings", () => {
    const token = "rly_secret_abcdefghijklmnop";
    const redactor = createRedactor(token);
    const result = redactor.text(
      `Authorization: Bearer ${token}\nRELAY_AGENT_TOKEN=${token}\nrelay_other_abcdefghijklmnop`,
    );
    expect(result).not.toContain(token);
    expect(result).not.toContain("relay_other_abcdefghijklmnop");
    expect(result.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });
});
