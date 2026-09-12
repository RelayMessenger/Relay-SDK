import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * The folder's link to its agent, the way `vercel link` leaves `.vercel/project.json`
 * and `supabase init` leaves `supabase/config.toml`: a pointer in the folder, the
 * credential in the global store (_artifacts/cli-connect-design-20260912.md, item 2).
 * `handle` names the saved profile; `apiUrl` says which Relay it lives on. No token.
 */
export interface FolderLink {
  handle: string;
  apiUrl: string;
}

export const FOLDER_LINK_DIR = ".relay";
export const folderLinkPath = (cwd: string): string => join(cwd, FOLDER_LINK_DIR, "agent.json");

const parseLink = (text: string): FolderLink | undefined => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (value === null || typeof value !== "object") return undefined;
  const { handle, apiUrl } = value as Record<string, unknown>;
  return typeof handle === "string" && handle && typeof apiUrl === "string" && apiUrl ? { handle, apiUrl } : undefined;
};

/** The nearest link at or above the folder, the way git finds its `.git`. */
export async function readFolderLink(cwd: string): Promise<(FolderLink & { path: string }) | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const path = folderLinkPath(dir);
    let text: string | undefined;
    try { text = await readFile(path, "utf8"); } catch { text = undefined; }
    const link = text === undefined ? undefined : parseLink(text);
    if (link) return { ...link, path };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Writes the link, owner-only, and adds `.relay` to the folder's `.gitignore`
 * when there is one, the way vercel adds `.vercel` (packages/cli/src/util/link/link.ts).
 * A folder without a `.gitignore` gets none: it is not a repository's business yet.
 */
export async function writeFolderLink(cwd: string, link: FolderLink): Promise<string> {
  const dir = join(cwd, FOLDER_LINK_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = folderLinkPath(cwd);
  await writeFile(path, `${JSON.stringify({ handle: link.handle, apiUrl: link.apiUrl }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  await ignoreFolderLink(cwd);
  return path;
}

const ignoreFolderLink = async (cwd: string): Promise<void> => {
  const gitignore = join(cwd, ".gitignore");
  let text: string;
  try { text = await readFile(gitignore, "utf8"); } catch { return; }
  if (text.split(/\r?\n/u).some((line) => line.trim() === FOLDER_LINK_DIR || line.trim() === `${FOLDER_LINK_DIR}/`)) return;
  await appendFile(gitignore, `${text.length && !text.endsWith("\n") ? "\n" : ""}${FOLDER_LINK_DIR}\n`);
};

/**
 * Which saved agent a folder means: the folder link first, then `RELAY_AGENT`,
 * then the last connected one. Profiles are keyed by handle, so the answer is a
 * profile name, or nothing when none of the three names a saved profile.
 */
export async function resolveFolderAgent(
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: { profiles: Record<string, { agent_token?: string }>; defaultAgent?: string },
): Promise<{ profile: string; source: "folder" | "env" | "default" } | undefined> {
  const saved = (name: string | undefined): name is string => name !== undefined && Boolean(config.profiles[name]?.agent_token);
  const link = await readFolderLink(cwd);
  if (link && saved(link.handle)) return { profile: link.handle, source: "folder" };
  if (saved(env.RELAY_AGENT)) return { profile: env.RELAY_AGENT, source: "env" };
  if (saved(config.defaultAgent)) return { profile: config.defaultAgent, source: "default" };
  return undefined;
}
