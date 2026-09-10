import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram, runCLI } from "./program.js";
import { flagRows } from "./help-groups.js";
import { CLI_ERROR_CODES, NEXT_STEP } from "./error-codes.js";
import { protectWindowsPath } from "./runtime-connect/windows-acl.js";
import { docsSection, docsSections } from "./agent-driver.js";

const homes: string[] = [];
async function privateHome(prefix: string): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  if (process.platform === "win32") await protectWindowsPath(home, true);
  homes.push(home);
  return home;
}
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function run(args: string[]) {
  const home = await privateHome("cli-principles-20260910-");
  const out: string[] = [], err: string[] = [];
  const code = await runCLI(["--agent", "no", ...args], {
    configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json") } },
    isInteractive: false, stdout: s => out.push(s), stderr: s => err.push(s),
    fetch: async () => new Response("# Relay\n## First\none\n## Second\ntwo\n"),
  });
  return { code, out: out.join(""), err: err.join("") };
}
// Decision rows 4, 6, 14; ledger P13/P40/P05, gh help exit-codes and clig Help.
it("each CLI code has a distinct next step", () => {
  expect(new Set(CLI_ERROR_CODES.map(code => NEXT_STEP[code])).size).toBe(CLI_ERROR_CODES.length);
});
it("every flag and argument has a description", () => {
  expect(flagRows(createProgram()).filter(row => !row.description.trim())).toEqual([]);
});
it("exit-code help prints the five promised numbers", async () => {
  const result = await run(["help", "exit-codes"]);
  expect(result.code).toBe(0);
  expect([...result.out.matchAll(/exit code will be (\d)/g)].map(m => Number(m[1]))).toEqual([0, 1, 2, 3, 4]);
});
// Ledger P01/P40 names these cases; JSON usage variants cover the missing matrix rows.
it.each([
  [["--version"], 0], [["--help"], 0], [["config-path"], 0], [["docs"], 0],
  [["agents", "list"], 0], [["auth", "logout"], 0], [["--nope"], 2], [["nosuchcommand"], 2],
  [["chats", "list"], 4], [["doctor", "--offline"], 1], [["chats", "get", "chat_missing"], 4], [["watch"], 4],
  [["connect", "--new", "--dry-run"], 2], [["--json", "--nope"], 2], [["--json", "nosuchcommand"], 2], [["--json", "chats", "list"], 4],
] as [string[], number][])("ledger exit matrix %j => %i", async (args, code) => {
  expect((await run(args)).code).toBe(code);
});
it("JSON usage errors contain only the promised fields", async () => {
  const r = await run(["--json", "--nope"]);
  expect(r.out).toBe(""); expect(Object.keys(JSON.parse(r.err)).sort()).toEqual(["code", "error", "next_step"]);
  expect(JSON.parse(r.err).code).toBe("usage");
});
it("root and nested help end in the two documentation lines", async () => {
  for (const args of [["--help"], ["help", "connect"], ["help", "exit-codes"]]) {
    expect((await run(args)).out.trimEnd().split("\n").slice(-2)).toEqual([
      "Docs: https://docs.relayapp.im", "Report a problem: https://github.com/RelayMessenger/Relay-SDK/issues",
    ]);
  }
});
it("no-input aliases non-interactive and changes the piped plan", async () => {
  const normal = await run(["connect", "claude", "--new", "--dry-run"]);
  for (const flag of ["--non-interactive", "--no-input"]) {
    const r = await run([flag, "connect", "claude", "--new", "--dry-run"]);
    expect(r.code).toBe(0); expect(r.out).not.toContain("Continue?"); expect(r.out).not.toBe(normal.out);
  }
});
it("about validates before any creation request", async () => {
  for (const command of [["agents", "create"], ["connect", "codex", "--new"], ["contact-card", "set", "--handle", "test.dev"]]) {
    for (const about of ["   ", "a".repeat(61)]) expect((await run([...command, "--about", about, "--json"])).code).toBe(2);
  }
});
it("docs sections keep only the requested H2", () => {
  const text = "# Relay\n## First\none\n## Second\ntwo\n";
  expect(docsSections(text)).toEqual(["First", "Second"]);
  expect(docsSection(text, "first")).toBe("## First\none\n");
});

it("installer output has neither terminal controls nor spinner frames", async () => {
  const { plainInstallerOutput } = await import("./skill-offer.js");
  const esc = String.fromCharCode(27);
  expect(plainInstallerOutput(`${esc}[31mBanner${esc}[0m\n${esc}[?25l◒ Cloning…${esc}[1G◐ Cloning…${esc}[1G◇ Done\n`)).toBe("Banner\n◇ Done\n");
});

// Relay-Server 3097dda request fields: prove the body, not only option parsing.
it("agent creation forwards trimmed about and omits it when absent", async () => {
  const { createAgentWithPicture } = await import("./agent-create.js");
  const { agentDependencies } = await import("./agents.js");
  for (const about of [undefined, "  Helps with your calendar  "]) {
    const home = await privateHome("cli-principles-20260910-about-");
    let body: Record<string, unknown> = {};
    const deps = agentDependencies({ home, env: { RELAY_CONFIG_PATH: join(home, "config.json") } }, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ agent: { handle: "calendar.dev", first_name: "Calendar", image_url: null }, secret: "rly_test_about_0123456789", share_url: "https://relayapp.im/calendar.dev" }, { status: 201 });
    });
    await createAgentWithPicture({ apiURL: "https://api.staging.relayapp.im", ...(about === undefined ? {} : { about }) }, deps);
    if (about === undefined) expect(body).not.toHaveProperty("about");
    else expect(body.about).toBe("Helps with your calendar");
  }
});
it("contact-card set sends the trimmed about field", async () => {
  const home = await privateHome("cli-principles-20260910-card-");
  let body: Record<string, unknown> = {};
  expect(await runCLI(["--agent", "no", "contact-card", "set", "--handle", "calendar.dev", "--about", "  Helps you plan  "], {
    configContext: { home, env: { RELAY_CONFIG_PATH: join(home, "config.json"), RELAY_AGENT_TOKEN: "rly_test_about_0123456789", RELAY_API_URL: "https://api.staging.relayapp.im" } },
    isInteractive: false, stdout: () => undefined, stderr: () => undefined,
    fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return Response.json({}); },
  })).toBe(0);
  expect(body).toEqual({ about: "Helps you plan" });
});
it("API failures retain numeric codes and select not-found exit", async () => {
  const { describeFailure } = await import("./errors.js");
  const { RelayAPIError } = await import("@relaymessenger/sdk");
  expect(describeFailure(new RelayAPIError("Missing", { status: 404, code: 10404 }))).toMatchObject({ code: "10404", exit: 3 });
});
it("quiet suppresses successful output but not usage errors", async () => {
  expect((await run(["--quiet", "config-path"])).out).toBe("");
  expect((await run(["--quiet", "--nope"])).err).toContain("unknown option");
});
