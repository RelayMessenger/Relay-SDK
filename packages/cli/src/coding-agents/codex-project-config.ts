import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

/**
 * One entry under `[mcp_servers.<name>]` in the shape Codex's own config
 * reference gives it: `command`, `args`, and an `env` table when there is one
 * (codex-rs/core/src/config_types.rs, `McpServerConfig`).
 */
export interface CodexProjectMcpServer {
  name: string;
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
}

export const codexProjectConfigPath = (folder: string): string => join(folder, ".codex", "config.toml");

/**
 * Writes `[mcp_servers.<name>]` into the folder's own `.codex/config.toml`,
 * Codex's project layer. Every other table and every other server in the file
 * is kept; the same server written twice is one entry. The file is created,
 * with its folder, when it does not exist.
 */
export async function writeCodexProjectMcpServer(folder: string, server: CodexProjectMcpServer): Promise<string> {
  const file = codexProjectConfigPath(folder);
  let config: Record<string, unknown> = {};
  try {
    config = parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const existing = config.mcp_servers;
  const servers = (existing !== null && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) as Record<string, unknown>;
  servers[server.name] = {
    command: server.command,
    args: [...server.args],
    ...(server.env && Object.keys(server.env).length ? { env: { ...server.env } } : {}),
  };
  config.mcp_servers = servers;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(config), "utf8");
  return file;
}
