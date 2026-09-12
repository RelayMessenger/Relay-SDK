import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";

export interface CodexProjectMcpServer { name: string; command: string; args: readonly string[] }

export async function writeCodexProjectMcpServer(folder: string, server: CodexProjectMcpServer): Promise<string> {
  const file = join(folder, ".codex", "config.toml");
  await mkdir(join(folder, ".codex"), { recursive: true });
  let config: Record<string, unknown> = {};
  try { config = parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const servers = (config.mcp_servers && typeof config.mcp_servers === "object" ? config.mcp_servers : {}) as Record<string, unknown>;
  servers[server.name] = { command: server.command, args: [...server.args] };
  config.mcp_servers = servers;
  await writeFile(file, stringify(config), "utf8");
  return file;
}
