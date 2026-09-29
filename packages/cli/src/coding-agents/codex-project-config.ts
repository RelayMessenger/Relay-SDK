import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

/**
 * One streamable HTTP entry under `[mcp_servers.<name>]`: `url` and
 * `bearer_token_env_var`, the keys `codex mcp add <name> --url <url>
 * --bearer-token-env-var <VAR>` writes (codex-cli 0.155.1,
 * _sources/mcp-hosted-docs-20260926/codex-mcp-add-url-config.txt).
 */
export interface CodexProjectMcpServer {
  name: string;
  url: string;
  bearer_token_env_var: string;
}

export const codexProjectConfigPath = (folder: string): string => join(folder, ".codex", "config.toml");

/**
 * Writes `[mcp_servers.<name>]` into the folder's own `.codex/config.toml`,
 * Codex's project layer. Every other table and every other server in the file
 * is kept; the same server written twice is one entry, and an older entry of
 * that name is replaced whole, so none of its keys are left behind. The file
 * is created, with its folder, when it does not exist.
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
  servers[server.name] = { url: server.url, bearer_token_env_var: server.bearer_token_env_var };
  config.mcp_servers = servers;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, stringify(config), "utf8");
  return file;
}
