import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { platformCommand, spawnArguments, spawnCommand } from "./spawn-command.js";

it("runs a Windows shim as cmd.exe /d /s /c with verbatim arguments, never an args array with shell: true", () => {
  // Node's own command line for `shell: true` (lib/child_process.js) and
  // cross-spawn's (lib/parse.js), without the call Node deprecates (DEP0190).
  const call = spawnArguments(platformCommand("C:\\bin\\cursor-agent.cmd", ["acp"], "win32"), { cwd: "C:\\work" }, "C:\\Windows\\system32\\cmd.exe");
  expect(call).toEqual({
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"^"C:\\bin\\cursor-agent.cmd^" ^"acp^""'],
    options: { cwd: "C:\\work", shell: false, windowsVerbatimArguments: true, windowsHide: true },
  });
  expect(spawnArguments(platformCommand("/usr/local/bin/cursor-agent", ["acp"], "darwin"))).toEqual({
    file: "/usr/local/bin/cursor-agent", args: ["acp"], options: { shell: false, windowsHide: true },
  });
  expect(spawnArguments(platformCommand("C:\\nodejs\\node.exe", ["x.cjs"], "win32")).options.shell).toBe(false);
});

it("spawnCommand starts a Windows shim through cmd.exe itself, so Node never builds the shell line or warns DEP0190", async () => {
  const warnings: string[] = [];
  const onWarning = (warning: Error & { code?: string }): void => { warnings.push(warning.code ?? warning.name); };
  process.on("warning", onWarning);
  try {
    // A shim path that exists nowhere: only the command line matters here.
    const child = spawnCommand("C:\\relay-missing\\cursor-agent.cmd", ["acp"], { stdio: "ignore" }, "win32");
    await new Promise<void>((resolve) => { child.once("error", () => resolve()); child.once("close", () => resolve()); });
    expect([child.spawnfile, ...child.spawnargs.slice(1)]).toEqual([
      process.env.comspec || "cmd.exe", "/d", "/s", "/c", '"^"C:\\relay-missing\\cursor-agent.cmd^" ^"acp^""',
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).not.toContain("DEP0190");
  } finally {
    process.off("warning", onWarning);
  }
});

it.runIf(process.platform === "win32")("starts a real .cmd shim with every argument intact and no DEP0190 warning", async () => {
  const folder = await mkdtemp(join(tmpdir(), "relay-spawn-command-"));
  const script = join(folder, "print-args.cjs");
  const shim = join(folder, "print args.cmd");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  // The shape npm's cmd-shim writes: node, the script, and `%*`.
  await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`, "utf8");
  const warnings: string[] = [];
  const onWarning = (warning: Error & { code?: string }): void => { warnings.push(warning.code ?? warning.name); };
  process.on("warning", onWarning);
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawnCommand(shim, ["acp", "two words", "a&b"], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}`)));
    });
    expect(JSON.parse(output)).toEqual(["acp", "two words", "a&b"]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).not.toContain("DEP0190");
  } finally {
    process.off("warning", onWarning);
  }
});
