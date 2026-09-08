// Owner rule: a word a reader has to ask about is a defect. The `--connect`
// surface is where a developer meets the most of them, so this test refuses the
// exact vocabulary the owner banned on 2026-09-08, in the two places it can
// reach a person: the messages this module produces, and the help text of the
// options that drive it.
//
// `acknowledge` is banned here on purpose. It survives only in
// `relay events listen` and its `--acknowledge-events` flag, neither of which
// this surface touches.
import { readFile } from "node:fs/promises";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { connectTarget } from "../src/agent-handoff.js";
import { createProgram } from "../src/program.js";
import { applyRuntimeConnect, planRuntimeConnect, type RuntimeConnectInput } from "../src/runtime-connect.js";
import { protectWindowsPath } from "../src/runtime-connect/windows-acl.js";

// A word list, not one long literal: written out as a single pattern this file
// would itself trip the repository grep that guards these words.
const BANNED_WORDS = [
  "ack", "acknowledg", "listener", "observer", "handoff", "bootstrap",
  "provisioning", "provenance", "consumer", "socket", "payload", "endpoint",
];
const BANNED_PHRASES = [["runtime", "ownership"], ["safe", "metadata"], ["credential", "results"]];
const BANNED = new RegExp(
  [...BANNED_WORDS.map(word => `\\b${word}`), ...BANNED_PHRASES.map(pair => pair.join("\\s+"))].join("|"),
  "iu",
);

const roots: string[] = [];
const token = "rly_private_test_only_not_real";
const origin = "https://api.staging.relayapp.im";
const agent = { token, origin, handle: "test_bird.dev" };
const consent = { consent: true, runtimeStopped: true } as const;
async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "relay-plain-words-")));
  roots.push(path);
  if (process.platform === "win32") await protectWindowsPath(path, true);
  return path;
}
async function privateFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600 });
  if (process.platform === "win32") await protectWindowsPath(path);
}
afterAll(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

/** Every string a plan, an apply or an undo can put in front of a person. */
const spoken = (value: { code: string; message: string; actions?: readonly string[] }): string =>
  [value.code, value.message, ...(value.actions ?? [])].join("\n");

it("says nothing to a developer in banned wire vocabulary, on the messages this surface really produces", async () => {
  const said: string[] = [];
  const home = await root();
  const clawPath = join(home, "openclaw.json");

  const say = async (input: RuntimeConnectInput): Promise<void> => {
    const plan = await planRuntimeConnect(input);
    said.push(spoken(plan));
    if (plan.status !== "ready") return;
    const applied = await applyRuntimeConnect(plan, consent);
    said.push(spoken(applied));
    said.push(spoken(await applyRuntimeConnect(plan, consent)));           // plan already used
    said.push(spoken(await applyRuntimeConnect(plan, { consent: false, runtimeStopped: false } as never)));
    if (applied.rollback) {
      said.push(spoken(await applied.rollback(consent)));
      said.push(spoken(await applied.rollback(consent)));                   // undone twice
      said.push(spoken(await applied.rollback({ consent: false, runtimeStopped: false } as never)));
    }
  };

  const claw = (config: unknown, over: Partial<{ account: string; brain: string; stateDir: string }> = {}): RuntimeConnectInput => ({
    agent: { ...agent },
    target: { runtime: "openclaw", configPath: clawPath, stateDir: over.stateDir ?? home, account: over.account ?? "work", ...(over.brain ? { brain: over.brain } : {}) },
  });

  // A working run, plus every refusal this module can reach from OpenClaw.
  await privateFile(clawPath, JSON.stringify({ channels: { relay: { accounts: { work: { allowFrom: ["alice"] }, other: { token: "other-token" } } } } }));
  await say(claw(undefined));
  await say({ ...claw(undefined), agent: { ...agent, token: "has spaces" } });
  await say({ ...claw(undefined), agent: { ...agent, origin: "http://api.example.com/v1" } });
  await say(claw(undefined, { account: "__proto__" }));
  await say(claw(undefined, { account: "Not Normalized" }));
  await say(claw(undefined, { brain: "brain-a" }));
  await say(claw(undefined, { stateDir: "relative/state" }));
  await privateFile(clawPath, JSON.stringify({ channels: { relay: { enabled: false, accounts: { work: {} } } } }));
  await say(claw(undefined));
  await privateFile(clawPath, JSON.stringify({ channels: { relay: { accounts: { work: { tokenFile: "/not-read" } } } } }));
  await say(claw(undefined));
  await privateFile(clawPath, JSON.stringify({ channels: { relay: { accounts: { work: { token: "another-token", baseUrl: origin } } } } }));
  await say(claw(undefined));
  await privateFile(clawPath, JSON.stringify({ channels: { relay: { accounts: { work: {}, other: { token } } } } }));
  await say(claw(undefined));
  await privateFile(clawPath, "{ not json");
  await say(claw(undefined));
  await writeFile(clawPath, "{}", { mode: 0o644 });
  if (process.platform !== "win32") await chmod(clawPath, 0o644);
  await say(claw(undefined));
  await rm(clawPath, { force: true });
  await say(claw(undefined));                                              // missing file

  // Claude Code and Hermes: their own refusals.
  const claude = await root();
  await privateFile(join(claude, ".env"), "RELAY_ALLOWED_SENDERS=\n");
  await say({ agent: { ...agent }, target: { runtime: "claude-code", channelDir: claude, context: "session-a" } });
  await privateFile(join(claude, ".env"), "RELAY_ALLOWED_SENDERS=alice\nRELAY_CHANNEL_SESSION_ID=other\n");
  await say({ agent: { ...agent }, target: { runtime: "claude-code", channelDir: claude, context: "session-a" } });
  await privateFile(join(claude, ".env"), "RELAY_ALLOWED_SENDERS=alice\nBROKEN LINE\n");
  await say({ agent: { ...agent }, target: { runtime: "claude-code", channelDir: claude, context: "session-a" } });
  const hermes = await root();
  await privateFile(join(hermes, "config.yaml"), "gateway:\n  platforms:\n    relayapp:\n      enabled: false\n");
  await say({ agent: { ...agent }, target: { runtime: "hermes", profileHome: hermes, stateDir: join(hermes, "state") } });
  await privateFile(join(hermes, "config.yaml"), "gateway: {\n");
  await say({ agent: { ...agent }, target: { runtime: "hermes", profileHome: hermes, stateDir: join(hermes, "state") } });

  // The CLI wrapper's own refusals, before any plan exists.
  const refusals: Array<Parameters<typeof connectTarget>[0]> = [
    { runtimeHome: "/tmp" },
    { connect: "openclaw" },
    { connect: "openclaw", confirmConfigure: true, runtimeStopped: true },
    { connect: "openclaw", confirmConfigure: true, runtimeStopped: true, runtimeAccount: "work", runtimeConfig: "relative.json" },
    { connect: "openclaw", confirmConfigure: true, runtimeStopped: true, runtimeAccount: "work", runtimeConfig: join(home, "absent.json"), runtimeStateDir: home },
    { connect: "claude-code", confirmConfigure: true, runtimeStopped: true },
    { connect: "nonsense", confirmConfigure: true, runtimeStopped: true },
  ];
  for (const options of refusals) {
    await expect(connectTarget(options)).rejects.toThrow();
    said.push(await connectTarget(options).then(() => "", (error: unknown) => (error as Error).message));
  }

  // The help text of the options that drive all of the above.
  const help = createProgram({}).commands.find(c => c.name() === "agents")!.commands.find(c => c.name() === "create")!.helpInformation();
  said.push(help);

  expect(said.length).toBeGreaterThan(25);
  expect(said.join("\n")).not.toMatch(BANNED);
  // Guard the guard: the collection really did capture text, not empty strings.
  expect(said.filter(Boolean).join("\n")).toContain("Stop the runtime you chose");
  expect(help).toContain("--connect <runtime>");
});

it("carries no banned word in any string this surface can print", async () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files = [
    join(src, "runtime-connect.ts"),
    join(src, "runtime-connect", "implementation.ts"),
    join(src, "runtime-connect", "windows-acl.ts"),
    join(src, "agent-handoff.ts"),
  ];
  for (const file of files) {
    const withoutComments = (await readFile(file, "utf8"))
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .replaceAll(/^[ \t]*\/\/.*$/gmu, "");
    const strings = [...withoutComments.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*)\1/gu)].map(match => match[2]!);
    expect(strings.length).toBeGreaterThan(5);
    // The label goes in expect's message, never in the asserted value: this
    // module's own file name contains one of the banned words.
    for (const value of strings) expect(value, file).not.toMatch(BANNED);
  }
});
