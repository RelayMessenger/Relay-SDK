import type { AgentPaths, CodingAgent } from "../coding-agents.js";
import { platformPath, configHome } from "./shared.js";

/**
 * VS Code's own user-data folder, copied from VS Code 1.139.1 (out/main.js,
 * the user-data path function, saved at
 * _sources/vscode-connect-test-20260926/vscode-1.139.1-main.js-userDataPath.txt):
 * `VSCODE_PORTABLE` → `<portable>/user-data`; `VSCODE_APPDATA` →
 * `<appdata>/Code`; otherwise Windows `APPDATA` (else `USERPROFILE\AppData\Roaming`),
 * macOS `~/Library/Application Support`, Linux `XDG_CONFIG_HOME` (else
 * `~/.config`), each + `Code`. VS Code tests each variable for truthiness, so
 * an empty one falls through the same way here. (`VSCODE_DEV` renames the
 * folder for a build run from source, `code-oss-dev`; that is not VS Code.)
 */
export const vscodeUserData = (paths: AgentPaths): string => {
  const path = platformPath(paths.platform);
  const env = paths.env;
  if (env.VSCODE_PORTABLE) return path.join(env.VSCODE_PORTABLE, "user-data");
  if (env.VSCODE_APPDATA) return path.join(env.VSCODE_APPDATA, "Code");
  switch (paths.platform) {
    case "win32": return path.join(env.APPDATA || path.join(env.USERPROFILE || paths.home, "AppData", "Roaming"), "Code");
    case "darwin": return path.join(paths.home, "Library", "Application Support", "Code");
    default: return path.join(env.XDG_CONFIG_HOME || path.join(paths.home, ".config"), "Code");
  }
};

const agent: CodingAgent =
  {
    id: "vscode",
    label: "VS Code",
    aliases: ["vs-code", "code"],
    // Docker's install check (`~/.config/Code`), then the folder VS Code
    // itself uses on this platform, then the macOS app.
    installedIf: (paths) => [
      platformPath(paths.platform).join(configHome(paths), "Code"),
      vscodeUserData(paths),
      "/Applications/Visual Studio Code.app",
    ],
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration: the
    // user file holds `servers.<name>`; a remote server is `type: "http"`, `url`,
    // `headers` (hosted-mcp.ts, `vscodeMcpEntry`). It is `User/mcp.json` in the
    // user-data folder VS Code itself resolves (`vscodeUserData`).
    connect: {
      kind: "mcp-file",
      file: (paths) => platformPath(paths.platform).join(vscodeUserData(paths), "User", "mcp.json"),
      shape: "vscode",
    },
    start: { kind: "restart", instruction: "Restart VS Code to load Relay, then ask it to read your Relay messages." },
    detectedAs: [],
  };

export default agent;
