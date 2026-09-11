import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codexThreadKey, codexThreadsPath, openCodexThreads } from "./codex-threads.js";

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

const home = async (): Promise<{ env: NodeJS.ProcessEnv }> => {
  const folder = await mkdtemp(join(tmpdir(), "relay-codex-threads-"));
  folders.push(folder);
  return { env: { RELAY_CONFIG_DIR: folder } };
};

const owner = { apiURL: "https://api.relayapp.im", handle: "agent.dev" };

describe("where the thread ids live", () => {
  it("keeps them beside the profile that owns the agent", async () => {
    const context = await home();
    expect(codexThreadsPath(context)).toBe(join(dirname(codexThreadsPath(context)), "codex-threads.json"));
    expect(dirname(codexThreadsPath(context))).toBe(dirname(join(context.env.RELAY_CONFIG_DIR!, "relay", "config.json")));
  });

  it("gives the same chat on two Relays, or two agents, two different threads", () => {
    expect(codexThreadKey(owner, "chat-1")).toBe("https://api.relayapp.im|agent.dev|chat-1");
    expect(codexThreadKey({ ...owner, apiURL: "https://api.staging.relayapp.im" }, "chat-1"))
      .not.toBe(codexThreadKey(owner, "chat-1"));
    expect(codexThreadKey({ ...owner, handle: "other.dev" }, "chat-1"))
      .not.toBe(codexThreadKey(owner, "chat-1"));
  });
});

describe("keeping a thread id", () => {
  it("gives back nothing for a chat this computer has never seen", async () => {
    const threads = await openCodexThreads(owner, await home());
    expect(threads.get("chat-1")).toBeUndefined();
  });

  it("gives the id back to the next run of the bridge", async () => {
    const context = await home();
    const first = await openCodexThreads(owner, context);
    await first.set("chat-1", "01a0-thread");
    const second = await openCodexThreads(owner, context);
    expect(second.get("chat-1")).toBe("01a0-thread");
    expect(second.get("chat-2")).toBeUndefined();
  });

  it("replaces an id it is given a second time", async () => {
    const context = await home();
    const threads = await openCodexThreads(owner, context);
    await threads.set("chat-1", "first-thread");
    await threads.set("chat-1", "second-thread");
    expect((await openCodexThreads(owner, context)).get("chat-1")).toBe("second-thread");
  });

  it("leaves another agent's threads in the file alone", async () => {
    const context = await home();
    const mine = await openCodexThreads(owner, context);
    const theirs = await openCodexThreads({ ...owner, handle: "other.dev" }, context);
    await theirs.set("chat-1", "their-thread");
    await mine.set("chat-1", "my-thread");
    const reopened = await openCodexThreads({ ...owner, handle: "other.dev" }, context);
    expect(reopened.get("chat-1")).toBe("their-thread");
    expect((await openCodexThreads(owner, context)).get("chat-1")).toBe("my-thread");
  });

  it("writes a file a person can read, and only the owner can", async () => {
    const context = await home();
    const threads = await openCodexThreads(owner, context);
    await threads.set("chat-1", "01a0-thread");
    expect(JSON.parse(await readFile(codexThreadsPath(context), "utf8")) as unknown).toEqual({
      version: 1,
      threads: { "https://api.relayapp.im|agent.dev|chat-1": "01a0-thread" },
    });
  });

  it.each([
    ["is not JSON at all", "this is not JSON"],
    ["holds no threads", '{"version":1}'],
    ["holds something that is not a thread id", '{"version":1,"threads":{"a":42}}'],
  ])("starts over when the file %s, because a lost thread costs only the context", async (_name, written) => {
    const context = await home();
    const path = codexThreadsPath(context);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, written, "utf8");
    const threads = await openCodexThreads(owner, context);
    expect(threads.get("chat-1")).toBeUndefined();
    await threads.set("chat-1", "fresh-thread");
    expect((await openCodexThreads(owner, context)).get("chat-1")).toBe("fresh-thread");
  });
});
