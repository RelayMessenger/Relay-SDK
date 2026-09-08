import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { configPath, emptyConfig, inspectConfigPermissions, writeConfig } from "./config.js";
import { inspectWindowsAcl, protectWindowsPath } from "./runtime-connect/windows-acl.js";

vi.mock("./runtime-connect/windows-acl.js", async (original) => ({
  ...await original<typeof import("./runtime-connect/windows-acl.js")>(),
  inspectWindowsAcl: vi.fn(), protectWindowsPath: vi.fn(),
}));
const acl = (sddl = "private") => ({ owner: "current", user: "current", sddl, rules: [{ sid: "current", rights: 2032127, type: "Allow" }] });
const unsafe = { ...acl("public"), rules: [{ sid: "S-1-1-0", rights: 2032127, type: "Allow" }] };
beforeEach(() => vi.resetAllMocks());
async function context() {
  const home = await mkdtemp(join(tmpdir(), "relay-acl-order-"));
  return { env: { RELAY_CONFIG_PATH: join(home, "config.json") }, platform: "win32" as const, home };
}
it("protects the empty temp before any secret bytes and inspects final ACL", async () => {
  const ctx = await context(); const config = emptyConfig(); config.profiles.default!.agent_token = "private-fixture-token";
  const order: string[] = [];
  vi.mocked(inspectWindowsAcl).mockImplementation(async (path) => {
    if (path === configPath(ctx)) { expect(await readFile(path, "utf8")).toContain("private-fixture-token"); order.push("final"); }
    return acl();
  });
  vi.mocked(protectWindowsPath).mockImplementation(async (path, directory, prior) => {
    expect((await readFile(path)).length).toBe(0); expect(directory).toBe(false); expect(prior).toBeUndefined(); order.push("empty-protected"); return acl();
  });
  await writeConfig(config, ctx);
  expect(order).toEqual(["empty-protected", "final"]);
});
it("preserves a secure existing descriptor and never changes parent ACLs", async () => {
  const ctx = await context(); await writeFile(configPath(ctx), JSON.stringify(emptyConfig()));
  vi.mocked(inspectWindowsAcl).mockResolvedValue(acl("existing-private"));
  vi.mocked(protectWindowsPath).mockImplementation(async (path, directory, prior) => {
    expect(path).not.toBe(ctx.home); expect(directory).toBe(false); expect(prior).toBe("existing-private"); expect((await readFile(path)).length).toBe(0); return acl("existing-private");
  });
  await writeConfig(emptyConfig(), ctx);
  expect(protectWindowsPath).toHaveBeenCalledOnce();
});
it("does not write secrets if private ACL creation fails and removes its empty temp", async () => {
  const ctx = await context(); vi.mocked(inspectWindowsAcl).mockResolvedValue(acl());
  vi.mocked(protectWindowsPath).mockResolvedValue(unsafe);
  await expect(writeConfig(emptyConfig(), ctx)).rejects.toThrow("before writing");
  expect(await readdir(ctx.home)).toEqual([]);
});
it("reports actual insecure or unavailable ACLs as not secure", async () => {
  const ctx = await context(); await writeFile(configPath(ctx), JSON.stringify(emptyConfig()));
  vi.mocked(inspectWindowsAcl).mockResolvedValue(unsafe);
  expect(await inspectConfigPermissions(ctx)).toMatchObject({ exists: true, secure: false, aclChecked: true });
  vi.mocked(inspectWindowsAcl).mockRejectedValue(new Error("native ACL unavailable"));
  expect(await inspectConfigPermissions(ctx)).toMatchObject({ exists: true, secure: false, aclChecked: false });
});
it("rejects a broad existing credential ACL without altering the file or directory", async () => {
  const ctx = await context(); const bytes = JSON.stringify(emptyConfig()); await writeFile(configPath(ctx), bytes);
  vi.mocked(inspectWindowsAcl).mockImplementation(async (path) => path === ctx.home ? acl() : unsafe);
  await expect(writeConfig(emptyConfig(), ctx)).rejects.toThrow("not private");
  expect(await readFile(configPath(ctx), "utf8")).toBe(bytes); expect(protectWindowsPath).not.toHaveBeenCalled();
});

it("blocks bootstrap on an insecure existing Windows config before any POST", async () => {
  const { agentDependencies, createAgent } = await import("./agents.js");
  const ctx = await context(); const before = JSON.stringify(emptyConfig()); await writeFile(configPath(ctx), before);
  vi.mocked(inspectWindowsAcl).mockImplementation(async (path) => path === ctx.home ? acl() : unsafe);
  const fetch = vi.fn();
  await expect(createAgent({}, agentDependencies(ctx, fetch))).rejects.toThrow("no agent creation request");
  expect(fetch).not.toHaveBeenCalled(); expect(await readFile(configPath(ctx), "utf8")).toBe(before);
});

it("blocks bootstrap when private temporary ACL protection is unavailable", async () => {
  const { agentDependencies, createAgent } = await import("./agents.js");
  const ctx = await context(); vi.mocked(inspectWindowsAcl).mockResolvedValue(acl());
  vi.mocked(protectWindowsPath).mockRejectedValue(new Error("ACL unavailable"));
  const fetch = vi.fn();
  await expect(createAgent({}, agentDependencies(ctx, fetch))).rejects.toThrow("preflight failed");
  expect(fetch).not.toHaveBeenCalled(); expect(await readdir(ctx.home)).toEqual([]);
});
