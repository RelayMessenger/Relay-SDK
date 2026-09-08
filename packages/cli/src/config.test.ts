import { inspectWindowsAcl, privateWindowsAcl, protectWindowsPath } from "./runtime-connect/windows-acl.js";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  inspectConfigPermissions,
  emptyConfig,
  readConfig,
  resolveAuth,
  validateApiURL,
  validateForwardURL,
  writeConfig,
} from "./config.js";

const context = async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-cli-config-"));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  return {
    home,
    env: { XDG_CONFIG_HOME: join(home, ".config") },
    platform: process.platform,
  };
};

describe("local config", { timeout: 120_000 }, () => {
  it("writes owner-only profile storage and never serializes environment tokens", async () => {
    const testContext = await context();
    const config = emptyConfig();
    config.profiles.default = {
      api_url: "https://api.staging.relayapp.im",
      agent_token: "stored-secret",
    };
    await writeConfig(config, testContext);

    if (process.platform === "win32") {
      expect(privateWindowsAcl(await inspectWindowsAcl(configPath(testContext)))).toBe(true);
      expect(await inspectConfigPermissions(testContext)).toMatchObject({ secure: true, aclChecked: true });
    } else {
    expect((await stat(configPath(testContext))).mode & 0o777).toBe(0o600);
    expect((await stat(join(configPath(testContext), ".."))).mode & 0o777)
      .toBe(0o700);
    }
    expect(await readConfig(testContext)).toEqual(config);
    expect(await readFile(configPath(testContext), "utf8")).toContain(
      "stored-secret",
    );
  });

  it("prefers environment auth without persisting it", async () => {
    const testContext = await context();
    await writeConfig(emptyConfig(), testContext);
    const resolved = await resolveAuth(undefined, {
      ...testContext,
      env: {
        ...testContext.env,
        RELAY_AGENT_TOKEN: "environment-secret",
        RELAY_API_URL: "http://127.0.0.1:8787",
      },
    });
    expect(resolved.token).toBe("environment-secret");
    expect(resolved.tokenSource).toBe("environment");
    expect(resolved.apiURL).toBe("http://127.0.0.1:8787");
    expect(await readFile(configPath(testContext), "utf8")).not.toContain(
      "environment-secret",
    );
  });

  it("rejects insecure API and non-loopback forwarding URLs", () => {
    expect(() => validateApiURL("http://api.relayapp.im")).toThrow(/HTTPS/);
    expect(() => validateApiURL("https://api.relayapp.im/path")).toThrow(/path/);
    expect(() => validateForwardURL("https://example.com/hook")).toThrow(
      /loopback/,
    );
    expect(validateForwardURL("http://localhost:3000/hook")).toBe(
      "http://localhost:3000/hook",
    );
  });
});

describe("config transactions", { timeout: 120_000 }, () => {
it("preserves an existing destination and removes temporary files after rename failure", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const testContext = await context();
  await mkdir(configPath(testContext), { recursive: true });
  await expect(writeConfig(emptyConfig(), testContext)).rejects.toThrow();
  expect(await readdir(dirname(configPath(testContext)))).toEqual(["config.json"]);
});

it("serializes concurrent profile mutations without losing either credential", async () => {
  const { mutateConfig } = await import("./config.js");
  const testContext = await context();
  await Promise.all(Array.from({ length: 8 }, (_, index) => mutateConfig((config) => {
    config.profiles[`agent-${index}.dev`] = { agent_token: `test-credential-${index}` };
  }, testContext)));
  const config = await readConfig(testContext);
  for (let index = 0; index < 8; index++) {
    expect(config.profiles[`agent-${index}.dev`]?.agent_token).toBe(`test-credential-${index}`);
  }
});

it("rejects stale legacy writes instead of overwriting a newly saved agent", async () => {
  const { mutateConfig } = await import("./config.js");
  const testContext = await context();
  const stale = await readConfig(testContext);
  await mutateConfig((config) => { config.profiles["new.dev"] = { agent_token: "new-credential" }; }, testContext);
  stale.profiles.default!.agent_token = "old-command-credential";
  await expect(writeConfig(stale, testContext)).rejects.toThrow("concurrently");
  expect((await readConfig(testContext)).profiles["new.dev"]?.agent_token).toBe("new-credential");
});

it("doctor checks real native file permissions and updates preserve parent permissions", async () => {
  const { chmod } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const { runDoctor } = await import("./doctor.js");
  const ctx = await context(); const config = emptyConfig();
  config.profiles.default = { api_url: "https://api.staging.relayapp.im", agent_token: "private-doctor-fixture" };
  await writeConfig(config, ctx);
  const path = configPath(ctx); const parent = dirname(path);
  const parentMode = (await stat(parent)).mode;
  const beforeACL = process.platform === "win32" ? await inspectWindowsAcl(path) : undefined;
  const parentACL = process.platform === "win32" ? await inspectWindowsAcl(parent) : undefined;
  const changed = await readConfig(ctx); changed.profiles.other = { api_url: "https://api.staging.relayapp.im" };
  await writeConfig(changed, ctx);
  if (beforeACL && parentACL) {
    expect((await inspectWindowsAcl(path)).sddl).toBe(beforeACL.sddl);
    expect((await inspectWindowsAcl(parent)).sddl).toBe(parentACL.sddl);
  } else expect((await stat(parent)).mode).toBe(parentMode);
  const report = () => runDoctor({ offline: true }, { configContext: ctx, createClient: () => { throw new Error("No network expected"); } });
  expect((await report()).checks.find((check) => check.name === "config_permissions")?.ok).toBe(true);
  if (beforeACL && parentACL) {
    // Deliberately weaken ONLY this synthetic fixture file, not its parent.
    await protectWindowsPath(path, false, `O:${beforeACL.user}G:${beforeACL.user}D:P(A;;FA;;;${beforeACL.user})(A;;FR;;;WD)`);
    expect((await inspectConfigPermissions(ctx)).secure).toBe(false);
    const { agentDependencies, createAgent } = await import("./agents.js");
    let posts = 0;
    await expect(createAgent({}, agentDependencies(ctx, async () => { posts++; throw new Error("No network expected"); }))).rejects.toThrow("preflight failed");
    expect(posts).toBe(0);
    expect((await inspectWindowsAcl(parent)).sddl).toBe(parentACL.sddl);
  } else await chmod(path, 0o644);
  const unsafe = await report();
  expect(unsafe.ok).toBe(false);
  expect(unsafe.checks.find((check) => check.name === "config_permissions")?.ok).toBe(false);
});

});
