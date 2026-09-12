import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { codexProjectConfigPath, writeCodexProjectMcpServer } from "./codex-project-config.js";

const relay = { name: "relay", command: "npx", args: ["-y", "@relaymessenger/mcp@staging", "--profile", "calm_cangoo.dev"] };

describe("the Codex project config writer", () => {
  it("creates .codex/config.toml with [mcp_servers.relay] when the folder has none", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-project-"));
    const file = await writeCodexProjectMcpServer(folder, relay);
    expect(file).toBe(codexProjectConfigPath(folder));
    expect(file).toBe(join(folder, ".codex", "config.toml"));
    expect(parse(await readFile(file, "utf8"))).toEqual({ mcp_servers: { relay: { command: "npx", args: relay.args } } });
  });

  it("merges into a file that already has other tables and other servers, all kept", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-project-"));
    await mkdir(join(folder, ".codex"));
    await writeFile(join(folder, ".codex", "config.toml"), [
      'model = "o3"',
      "",
      "[sandbox_workspace_write]",
      "network_access = true",
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n"));
    await writeCodexProjectMcpServer(folder, { ...relay, env: { RELAY_CONFIG_PATH: "/tmp/x/config.json" } });
    expect(parse(await readFile(join(folder, ".codex", "config.toml"), "utf8"))).toEqual({
      model: "o3",
      sandbox_workspace_write: { network_access: true },
      mcp_servers: {
        other: { command: "x" },
        relay: { command: "npx", args: relay.args, env: { RELAY_CONFIG_PATH: "/tmp/x/config.json" } },
      },
    });
  });

  it("is idempotent: written twice, one relay entry and the same bytes", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-project-"));
    await writeCodexProjectMcpServer(folder, relay);
    const once = await readFile(join(folder, ".codex", "config.toml"), "utf8");
    await writeCodexProjectMcpServer(folder, relay);
    const twice = await readFile(join(folder, ".codex", "config.toml"), "utf8");
    expect(twice).toBe(once);
    expect(once.match(/\[mcp_servers\.relay\]/gu)).toHaveLength(1);
  });

  it("a file that is not TOML is left alone and the error names it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-project-"));
    await mkdir(join(folder, ".codex"));
    await writeFile(join(folder, ".codex", "config.toml"), "= not toml");
    await expect(writeCodexProjectMcpServer(folder, relay)).rejects.toThrow();
    expect(await readFile(join(folder, ".codex", "config.toml"), "utf8")).toBe("= not toml");
  });
});
