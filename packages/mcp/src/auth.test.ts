import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLocalTokens,
  defaultApiURL,
  relayConfigPath,
  resolveAgentAuth,
  validateApiURL,
} from "./auth.js";

describe("local Agent Token resolver", () => {
  it("matches package environment for staging and plain release versions", () => {
    expect(defaultApiURL("0.1.3-staging.7")).toBe("https://api.staging.relayapp.im");
    expect(defaultApiURL("0.1.3-staging")).toBe("https://api.staging.relayapp.im");
    expect(defaultApiURL("0.1.3")).toBe("https://api.relayapp.im");
  });

  it("uses the package origin with only an environment Agent Token and a fresh home", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-package-default-"));
    const resolved = await resolveAgentAuth({
      home,
      env: { RELAY_AGENT_TOKEN: "rly_environment_secret" },
    });
    // The build's own origin: staging for a -staging.N version, production for
    // a plain one (the release job rewrites the version before it tests).
    expect(resolved.apiURL).toBe(defaultApiURL());
    expect(resolved.source).toBe("environment");
  });

  it("preserves explicit profile, environment, and command origins in precedence order", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-origin-precedence-"));
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({
      version: 1, current_profile: "default",
      profiles: { default: { api_url: "https://api.relayapp.im", agent_token: "profile-secret" } },
    }));
    const env = { RELAY_CONFIG_PATH: path, RELAY_AGENT_TOKEN: "env-secret" };
    expect((await resolveAgentAuth({ env })).apiURL).toBe("https://api.relayapp.im");
    expect((await resolveAgentAuth({ env: { ...env, RELAY_API_URL: "http://127.0.0.1:8787" } })).apiURL).toBe("http://127.0.0.1:8787");
    expect((await resolveAgentAuth({
      env: { ...env, RELAY_API_URL: "http://127.0.0.1:8787" },
      apiURL: "https://api.staging.relayapp.im",
    })).apiURL).toBe("https://api.staging.relayapp.im");
  });

  it("uses the package origin when a selected profile omits api_url", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-profile-default-"));
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({
      version: 1, current_profile: "default",
      profiles: { default: { agent_token: "profile-secret" } },
    }));
    expect((await resolveAgentAuth({ env: { RELAY_CONFIG_PATH: path } })).apiURL).toBe(defaultApiURL());
  });

  it("reads the Relay CLI profile format", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-auth-"));
    const context = {
      home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
    };
    const path = relayConfigPath(context);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      version: 1,
      current_profile: "brave_cangoo",
      profiles: {
        "brave_cangoo": {
          api_url: "https://api.staging.relayapp.im",
          agent_token: "rly_profile_secret",
        },
      },
    }));
    const resolved = await resolveAgentAuth(context);
    expect(resolved.profile).toBe("brave_cangoo");
    expect(resolved.source).toBe("profile");
    expect(resolved.token).toBe("rly_profile_secret");
    expect(await collectLocalTokens(context)).toEqual(["rly_profile_secret"]);
  });

  it("prefers environment auth and permits only loopback HTTP", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-env-auth-"));
    const resolved = await resolveAgentAuth({
      env: {
        RELAY_CONFIG_PATH: join(home, "config.json"),
        RELAY_AGENT_TOKEN: "rly_environment_secret",
        RELAY_API_URL: "http://127.0.0.1:8787",
      },
    });
    expect(resolved.source).toBe("environment");
    expect(resolved.apiURL).toBe("http://127.0.0.1:8787");
    expect(() => validateApiURL("http://api.relayapp.im")).toThrow(/HTTPS/);
  });

  it("fails without exposing or inventing a credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-mcp-empty-auth-"));
    await expect(resolveAgentAuth({
      home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
    })).rejects.toThrow(/No Agent Token/);
  });
});
