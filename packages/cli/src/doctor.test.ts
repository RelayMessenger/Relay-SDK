import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyConfig, writeConfig, type RelayConfig } from "./config.js";
import { runCLI } from "./program.js";

const run = async (profiles: RelayConfig["profiles"], signedIn = true, profile?: string) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-doctor-signin-"));
  const configContext = { cwd: directory, env: { RELAY_CONFIG_PATH: join(directory, "config.json") } };
  await writeConfig({
    ...emptyConfig(),
    current_profile: Object.keys(profiles)[0]!,
    profiles,
    ...(signedIn ? { console: {
      access_token: "session-test",
      expires_at: Date.now() + 60_000,
      user: { id: "user-test", email: "doctor@example.com" },
    } } : {}),
  }, configContext);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCLI([
    ...(profile ? ["--profile", profile] : []), "doctor", "--offline",
  ], {
    configContext,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
};

describe("doctor sign-in", () => {
  it("passes after fresh sign-in with only the default placeholder and no agents", async () => {
    const result = await run(emptyConfig().profiles);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("doctor@example.com");
    expect(result.stdout).toContain("No agents yet. Run npx relaymessenger connect");
  });

  it.each([
    { agent: {} },
    { default: {}, agent: { agent_token: "rly_test" } },
  ])("fails when a real profile has no token: %j", async (profiles) => {
    const result = await run(profiles);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("has no saved token");
    expect(result.stdout).not.toContain("No agents yet.");
  });

  it("fails the Sign-in check without a saved console session", async () => {
    const result = await run(emptyConfig().profiles, false);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Sign-in");
    expect(result.stdout).toContain("Not signed in. Run npx relaymessenger login");
    expect(result.stdout).not.toContain("No agents yet.");
  });

  it("does not hide a requested profile that does not exist", async () => {
    const result = await run(emptyConfig().profiles, true, "missing");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("does not exist");
  });
});
