import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  emptyConfig,
  readConfig,
  resolveAuth,
  validateApiURL,
  validateForwardURL,
  writeConfig,
} from "./config.js";

const context = async () => {
  const home = await mkdtemp(join(tmpdir(), "relay-cli-config-"));
  return {
    home,
    env: { XDG_CONFIG_HOME: join(home, ".config") },
    platform: process.platform,
  };
};

describe("local config", () => {
  it("writes owner-only profile storage and never serializes environment tokens", async () => {
    const testContext = await context();
    const config = emptyConfig();
    config.profiles.default = {
      api_url: "https://api.relayapp.im",
      agent_token: "stored-secret",
    };
    await writeConfig(config, testContext);

    if (process.platform !== "win32") {
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
