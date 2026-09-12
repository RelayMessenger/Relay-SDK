import { access, appendFile, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface FolderLink { handle: string; apiUrl: string }
export const folderLinkPath = (cwd: string) => join(cwd, ".relay", "agent.json");
export async function readFolderLink(cwd: string): Promise<(FolderLink & { path: string }) | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const path = folderLinkPath(dir);
    try { const value = JSON.parse(await readFile(path, "utf8")) as FolderLink; if (typeof value.handle === "string" && typeof value.apiUrl === "string") return { ...value, path }; } catch {}
    const parent = dirname(dir); if (parent === dir) return undefined; dir = parent;
  }
}
export async function writeFolderLink(cwd: string, link: FolderLink): Promise<string> {
  const dir = join(cwd, ".relay"); await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "agent.json"); await writeFile(path, JSON.stringify(link, null, 2) + "\n", { mode: 0o600 }); await chmod(path, 0o600);
  const gitignore = join(cwd, ".gitignore"); try { const text = await readFile(gitignore, "utf8"); if (!text.split(/\r?\n/).some(x => x.trim() === ".relay")) await appendFile(gitignore, `${text.endsWith("\n") ? "" : "\n"}.relay\n`); } catch {}
  return path;
}
export async function resolveAgent(cwd: string, env: NodeJS.ProcessEnv, profiles: Record<string, FolderLink>, skipFolder = false): Promise<FolderLink | undefined> {
  if (!skipFolder) { const link = await readFolderLink(cwd); if (link) return link; }
  const handle = env.RELAY_AGENT; if (handle && profiles[handle]) return profiles[handle];
  return profiles["defaultAgent"];
}
