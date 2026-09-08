import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isStagingBuild, packageVersion } from "./config.js";

/** The skill ships from the branch the build was cut from: a `-staging` build installs `tree/staging`, a plain release installs `tree/main`. */
export const relaySkillSourceBranch = (version: string = packageVersion()): "staging" | "main" =>
  isStagingBuild(version) ? "staging" : "main";
export const relaySkillInstallArgs = (version: string = packageVersion()): readonly string[] =>
  ["--yes", "skills@1.5.25", "add", `https://github.com/RelayMessenger/Relay-SDK/tree/${relaySkillSourceBranch(version)}/skills/relay`, "--skill", "relay"];
export const RELAY_SKILL_INSTALL_ARGS = relaySkillInstallArgs();
// Actual supported installation paths from the pinned installer README, saved
// in interactive-reference/skills-README.md:273-340. No guessed runtime paths.
const projectRoots = [
  ".aider-desk/skills",
  ".agents/skills",
  "data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  "skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".devin/skills",
  ".factory/skills",
  "agent/skills",
  ".forge/skills",
  ".goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kimchi/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".openhands/skills",
  ".ona/skills",
  ".pi/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills"
];
const globalRoots = [
  ".aider-desk/skills",
  ".config/agents/skills",
  ".gemini/antigravity/skills",
  ".gemini/antigravity-cli/skills",
  ".astrbot/data/skills",
  ".autohand/skills",
  ".augment/skills",
  ".bob/skills",
  ".claude/skills",
  ".openclaw/skills",
  ".agents/skills",
  ".codeartsdoer/skills",
  ".codebuddy/skills",
  ".codemaker/skills",
  ".codestudio/skills",
  ".codex/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".snowflake/cortex/skills",
  ".config/crush/skills",
  ".cursor/skills",
  ".deepagents/agent/skills",
  ".config/devin/skills",
  ".factory/skills",
  ".firebender/skills",
  ".forge/skills",
  ".gemini/skills",
  ".copilot/skills",
  ".config/goose/skills",
  ".grok/skills",
  ".hermes/skills",
  ".inferencesh/skills",
  ".jazz/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".config/kimchi/harness/skills",
  ".kiro/skills",
  ".kode/skills",
  ".lingma/skills",
  ".mcpjam/skills",
  ".minimax/skills",
  ".vibe/skills",
  ".moxby/skills",
  ".mux/skills",
  ".config/opencode/skills",
  ".openhands/skills",
  ".ona/skills",
  ".pi/agent/skills",
  ".posit/assistant/skills",
  ".qoder/skills",
  ".qoder-cn/skills",
  ".qwen/skills",
  ".reasonix/skills",
  ".rovodev/skills",
  ".roo/skills",
  ".tabnine/agent/skills",
  ".terramind/skills",
  ".tinycloud/skills",
  ".trae/skills",
  ".trae-cn/skills",
  ".codeium/windsurf/skills",
  ".zcode/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills"
];
export async function relaySkillPresent(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean | "unknown"> {
  // skills@1.5.25 cli.mjs:1334–1339,1443–1449,1506–1512,1662–1669.
  // Overrides replace, rather than supplement, these agents' default homes.
  const selectedHomes: Record<string, string | undefined> = {
    ".codex/skills": env.CODEX_HOME?.trim(),
    ".claude/skills": env.CLAUDE_CONFIG_DIR?.trim(),
    ".hermes/skills": env.HERMES_HOME?.trim(),
  };
  const globalPaths = globalRoots.map((path) => selectedHomes[path]
    ? resolve(cwd, selectedHomes[path]!, "skills", "relay", "SKILL.md")
    : join(home, path, "relay", "SKILL.md"));
  let unknown = false;
  for (const path of [...projectRoots.map((path) => join(cwd, path, "relay", "SKILL.md")), ...globalPaths]) {
    try { if ((await stat(path)).isFile()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") unknown = true; }
  }
  return unknown ? "unknown" : false;
}
export function installerEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The public installer needs OS/terminal locations, not Relay/provider tokens.
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "TEMP", "TMP", "TMPDIR", "TERM", "COLORTERM", "TERM_PROGRAM", "LANG", "LC_ALL", "NO_COLOR", "FORCE_COLOR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HERMES_HOME", "DISABLE_TELEMETRY", "DO_NOT_TRACK"]);
  return Object.fromEntries(Object.entries(parent).filter(([name]) => allowed.has(name.toUpperCase())));
}
export async function resolveNpx(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string> {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = [dirname(process.execPath), ...pathValue.split(delimiter)];
  for (const raw of directories) {
    const directory = raw.replace(/^"(.*)"$/u, "$1");
    if (!isAbsolute(directory)) continue;
    const path = join(directory, platform === "win32" ? "npx.cmd" : "npx");
    try { await access(path, platform === "win32" ? constants.F_OK : constants.X_OK); return path; } catch { /* Try next explicit PATH entry. */ }
  }
  throw new Error("Relay could not find npx on this computer. Install Node.js, which includes npm and npx, then run this command again.");
}
export async function installRelaySkill(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const executable = await resolveNpx(env);
  const windows = process.platform === "win32";
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(windows ? quote(executable) : executable, windows ? RELAY_SKILL_INSTALL_ARGS.map(quote) : [...RELAY_SKILL_INSTALL_ARGS], {
      cwd, env: installerEnvironment(env), stdio: "inherit", shell: windows, windowsHide: true,
    });
    let finished = false;
    const interrupted = () => { child.kill("SIGINT"); };
    process.on("SIGINT", interrupted);
    const finish = (ok: boolean) => {
      if (finished) return; finished = true; process.removeListener("SIGINT", interrupted);
      if (ok) resolve(); else reject(new Error("The Relay skill was not installed. Your agent and your saved token are unchanged."));
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
