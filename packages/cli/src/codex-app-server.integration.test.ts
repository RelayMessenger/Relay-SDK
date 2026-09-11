import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CODEX_APPROVAL_POLICY, CODEX_SANDBOX, CLIENT_NAME, codexCommand, runTurn, startAppServer } from "./codex-bridge.js";
import { findExecutable } from "./runtime-sniff.js";

/**
 * The one test that talks to the real `codex app-server`, so the hand-written
 * shapes in codex-bridge.ts are checked against the program they describe
 * rather than against a stand-in. It is skipped where Codex is not installed,
 * which is every machine that builds this package.
 */
const installed = await findExecutable("codex", process.env, process.platform) !== undefined;

const folders: string[] = [];
afterAll(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe.skipIf(!installed)("the codex on this computer", () => {
  it("takes a message and answers it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "relay-codex-live-"));
    folders.push(folder);
    const control = new AbortController();
    const server = startAppServer(await codexCommand("codex"), folder, control.signal);
    try {
      const hello = await server.request("initialize", {
        clientInfo: { name: CLIENT_NAME, title: "Relay", version: "0.0.0-test" },
      });
      expect(hello.codexHome).toEqual(expect.any(String));
      server.notify("initialized", {});

      const thread = await server.request("thread/start", {
        cwd: folder, sandbox: CODEX_SANDBOX, approvalPolicy: CODEX_APPROVAL_POLICY,
      });
      const threadId = (thread.thread as { id?: unknown }).id;
      expect(threadId).toEqual(expect.any(String));

      let turnId = "";
      const outcome = await runTurn(server, {
        threadId: threadId as string,
        prompt: "Reply with the single word pong and nothing else.",
        onStarted: (turn) => { turnId = turn.turnId; },
      });
      expect(turnId).toEqual(expect.any(String));
      expect(outcome.status).toBe("completed");
      expect(outcome.answer.toLowerCase()).toContain("pong");
    } finally { control.abort(); }
  }, 180_000);
});
