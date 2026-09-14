import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { folderLinkPath, readFolderLink, resolveFolderAgent, writeFolderLink } from "./folder-link.js";

const link = { handle: "calm_cangoo", apiUrl: "https://api.staging.relayapp.im" };

describe("the folder link", () => {
  it("writes .relay/agent.json as a pointer with no token, owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-folder-link-"));
    const path = await writeFolderLink(root, { ...link, token: "rel_token_never" } as never);
    expect(path).toBe(folderLinkPath(root));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(link);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("is found from a child folder, the way git finds .git", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-folder-link-"));
    await writeFolderLink(root, link);
    const child = join(root, "a", "b");
    await mkdir(child, { recursive: true });
    expect(await readFolderLink(child)).toEqual({ ...link, path: folderLinkPath(root) });
    expect(await readFolderLink(await mkdtemp(join(tmpdir(), "relay-folder-unlinked-")))).toBeUndefined();
  });

  it("a broken or tokenless file is not a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-folder-link-"));
    await mkdir(join(root, ".relay"));
    await writeFile(folderLinkPath(root), "{ not json");
    expect(await readFolderLink(root)).toBeUndefined();
    await writeFile(folderLinkPath(root), JSON.stringify({ handle: "x" }));
    expect(await readFolderLink(root)).toBeUndefined();
  });

  it("adds .relay to an existing .gitignore once, and never creates one", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-folder-link-"));
    await writeFolderLink(root, link);
    await expect(access(join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, ".gitignore"), "node_modules");
    await writeFolderLink(root, link);
    await writeFolderLink(root, link);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules\n.relay\n");
    await writeFile(join(root, ".gitignore"), ".relay/\n");
    await writeFolderLink(root, link);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".relay/\n");
  });

  it("resolves the folder link, then RELAY_AGENT, then the last connected agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-folder-link-"));
    const config = { profiles: { "f": { agent_token: "t" }, "e": { agent_token: "t" }, "d": { agent_token: "t" }, empty: {} }, defaultAgent: "d" };
    expect(await resolveFolderAgent(root, {}, config)).toEqual({ profile: "d", source: "default" });
    expect(await resolveFolderAgent(root, { RELAY_AGENT: "e" }, config)).toEqual({ profile: "e", source: "env" });
    await writeFolderLink(root, { handle: "f", apiUrl: link.apiUrl });
    expect(await resolveFolderAgent(root, { RELAY_AGENT: "e" }, config)).toEqual({ profile: "f", source: "folder" });
    // A link to a handle this computer does not hold falls through.
    await writeFolderLink(root, { handle: "gone", apiUrl: link.apiUrl });
    expect(await resolveFolderAgent(root, {}, config)).toEqual({ profile: "d", source: "default" });
    expect(await resolveFolderAgent(root, { RELAY_AGENT: "empty" }, { profiles: config.profiles })).toBeUndefined();
  });
});
