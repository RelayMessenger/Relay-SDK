import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLocalTokens,
  relayConfigPath,
  resolveAgentAuth,
  validateApiURL,
} from "./auth.js";

describe("local Agent Token resolver", () => {
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
      current_profile: "brave_cangoo.dev",
      profiles: {
        "brave_cangoo.dev": {
          api_url: "https://api.staging.relayapp.im",
          agent_token: "rly_profile_secret",
        },
      },
    }));
    const resolved = await resolveAgentAuth(context);
    expect(resolved.profile).toBe("brave_cangoo.dev");
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
