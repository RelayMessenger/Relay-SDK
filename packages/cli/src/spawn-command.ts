import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * How this CLI starts a program somebody else installed, on every platform.
 *
 * Windows has no file called `codex` or `claude`: npm installs a command-line
 * program as a `.cmd` shim, and Node refuses to spawn a `.cmd` or a `.bat`
 * without a shell — it fails with EINVAL instead, which is the fix for
 * CVE-2024-27980 (nodejs/node commit 6627222, shipped in 18.20.2, 20.12.2,
 * 21.7.3 and every 22). So on Windows anything that is not an `.exe` runs
 * through the shell, with the file and every argument escaped the way
 * cross-spawn escapes them (7.0.6, lib/util/escape.js) — the Node advisory
 * asks that of every caller that turns the shell on. Every other platform runs
 * the file itself, with no shell to read the arguments a second time.
 *
 * `cmd.exe` ends a command at the first carriage return or newline and no
 * escape prevents it (Shescape GHSA-jjc5-fp7p-6f8w; Rust and Zig refuse to
 * spawn a batch file with one), so text a person wrote never travels on a
 * command line here. The Codex bridge hands its prompt to Codex on stdin
 * instead (codex-bridge.ts).
 */
export interface PlatformCommand {
  file: string;
  args: string[];
  /** Windows reads a `.cmd` shim only through `cmd.exe`. */
  shell: boolean;
}

const CMD_META_CHARACTERS = /[()\][%!^"`<>&|;, *?]/gu;

/** cross-spawn's escape: quote the value, then hide every character `cmd.exe` reads. */
const escapeForCmd = (value: string): string => `"${value
  .replace(/(\\*)"/gu, "$1$1\\\"")
  .replace(/(\\*)$/u, "$1$1")}"`
  .replace(CMD_META_CHARACTERS, "^$&");

/** The file and the arguments as this platform must receive them. */
export const platformCommand = (
  file: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): PlatformCommand => platform === "win32" && !/\.exe$/iu.test(file)
  ? { file: escapeForCmd(file), args: args.map(escapeForCmd), shell: true }
  : { file, args: [...args], shell: false };

/**
 * What `spawn` receives. A shim runs as `cmd.exe /d /s /c "<line>"` with the
 * arguments passed verbatim: the command line Node itself builds for
 * `shell: true` (lib/child_process.js, `normalizeSpawnArguments`) and the one
 * cross-spawn builds (7.0.6, lib/parse.js). Node deprecates an `args` array
 * with `shell: true` (DEP0190, runtime since v24.0.0) and documents spawning
 * `cmd.exe` with the shim as its argument instead (doc/api/child_process.md,
 * "Spawning .bat and .cmd files on Windows"); both saved at
 * _sources/node-dep0190-20260926/.
 */
export const spawnArguments = (
  line: PlatformCommand,
  options: SpawnOptions = {},
  comspec: string = process.env.comspec || "cmd.exe",
): { file: string; args: string[]; options: SpawnOptions } => line.shell
  ? { file: comspec, args: ["/d", "/s", "/c", `"${[line.file, ...line.args].join(" ")}"`], options: { ...options, shell: false, windowsVerbatimArguments: true, windowsHide: true } }
  : { file: line.file, args: line.args, options: { ...options, shell: false, windowsHide: true } };

/** Starts that program, and hands the caller the process it started. */
export const spawnCommand = (
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): ChildProcess => {
  const call = spawnArguments(platformCommand(file, args, platform), options);
  return spawn(call.file, call.args, call.options);
};
