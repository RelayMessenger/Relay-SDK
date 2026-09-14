import { posix, win32 } from "node:path";
import type { CodingAgent } from "../coding-agents.js";
import { platformPath, appData, configHome, appSupport, byPlatform } from "./shared.js";

const agent: CodingAgent =
  {
    id: "vscode",
    label: "VS Code",
    aliases: ["vs-code", "code"],
    installedIf: (paths) => [
      platformPath(paths.platform).join(configHome(paths), "Code"),
      win32.join(appData(paths), "Code"),
      "/Applications/Visual Studio Code.app",
    ],
    // https://code.visualstudio.com/docs/copilot/reference/mcp-configuration: the
    // user file holds `servers.<name>` with `type: "stdio"`, `command`, `args`,
    // `env`. Its location is the User folder of the profile (Docker's registry,
    // row `vscode`: ~/.config/Code/User/mcp.json, ~/Library/Application
    // Support/Code/User/mcp.json, %APPDATA%\Code\User\mcp.json).
    connect: {
      kind: "mcp-file",
      file: (paths) => byPlatform(paths, {
        darwin: posix.join(appSupport(paths), "Code", "User", "mcp.json"),
        win32: win32.join(appData(paths), "Code", "User", "mcp.json"),
        linux: posix.join(paths.home, ".config", "Code", "User", "mcp.json"),
      }),
      shape: "vscode",
    },
    start: { kind: "restart", instruction: "Restart VS Code to load Relay, then ask it to read your Relay messages." },
    detectedAs: [],
  };

export default agent;
