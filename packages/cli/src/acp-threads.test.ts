import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { acpSessionKey, acpSessionsPath, openAcpSessions } from "./acp-threads.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

const home = async (): Promise<{ env: NodeJS.ProcessEnv }> => {
  const folder = await mkdtemp(join(tmpdir(), "relay-acp-sessions-"));
  folders.push(folder);
  return { env: { RELAY_CONFIG_DIR: folder } };
};

const owner = { apiURL: "https://api.relayapp.im", handle: "agent.dev" };

describe("where the ACP session ids live", () => {
  it("keeps them beside the profile that owns the agent, apart from Codex's", async () => {
    const context = await home();
    expect(acpSessionsPath(context)).toBe(join(dirname(acpSessionsPath(context)), "acp-sessions.json"));
    expect(dirname(acpSessionsPath(context))).toBe(dirname(join(context.env.RELAY_CONFIG_DIR!, "relay", "config.json")));
  });

  it("gives the same chat on two Relays, or two agents, two different sessions", () => {
    expect(acpSessionKey(owner, "chat-1")).toBe("https://api.relayapp.im|agent.dev|chat-1");
    expect(acpSessionKey({ ...owner, apiURL: "https://api.staging.relayapp.im" }, "chat-1"))
      .not.toBe(acpSessionKey(owner, "chat-1"));
    expect(acpSessionKey({ ...owner, handle: "other.dev" }, "chat-1"))
      .not.toBe(acpSessionKey(owner, "chat-1"));
  });
});

describe("keeping a session id", () => {
  it("gives the id back to the next run of the bridge", async () => {
    const context = await home();
    const first = await openAcpSessions(owner, context);
    await first.set("chat-1", "session-1");
    const second = await openAcpSessions(owner, context);
    expect(second.get("chat-1")).toBe("session-1");
    expect(second.get("chat-2")).toBeUndefined();
  });

  it("leaves another agent's sessions in the file alone", async () => {
    const context = await home();
    const mine = await openAcpSessions(owner, context);
    const theirs = await openAcpSessions({ ...owner, handle: "other.dev" }, context);
    await theirs.set("chat-1", "their-session");
    await mine.set("chat-1", "my-session");
    const reopened = await openAcpSessions({ ...owner, handle: "other.dev" }, context);
    expect(reopened.get("chat-1")).toBe("their-session");
    expect((await openAcpSessions(owner, context)).get("chat-1")).toBe("my-session");
  });

  it("writes a file a person can read, and only the owner can", async () => {
    const context = await home();
    const sessions = await openAcpSessions(owner, context);
    await sessions.set("chat-1", "session-1");
    expect(JSON.parse(await readFile(acpSessionsPath(context), "utf8")) as unknown).toEqual({
      version: 1,
      sessions: { "https://api.relayapp.im|agent.dev|chat-1": "session-1" },
    });
  });

  it.each([
    ["is not JSON at all", "this is not JSON"],
    ["holds no sessions", '{"version":1}'],
    ["holds something that is not a session id", '{"version":1,"sessions":{"a":42}}'],
  ])("starts over when the file %s, because a lost session costs only the context", async (_name, written) => {
    const context = await home();
    const path = acpSessionsPath(context);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, written, "utf8");
    const sessions = await openAcpSessions(owner, context);
    expect(sessions.get("chat-1")).toBeUndefined();
    await sessions.set("chat-1", "fresh-session");
    expect((await openAcpSessions(owner, context)).get("chat-1")).toBe("fresh-session");
  });
});
