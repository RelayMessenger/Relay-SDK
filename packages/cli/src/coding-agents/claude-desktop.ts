import { posix, win32 } from "node:path";
import type { CodingAgent } from "../coding-agents.js";
import { appData, appSupport, byPlatform } from "./shared.js";

const agent: CodingAgent =
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    aliases: ["desktop"],
    installedIf: (paths) => ["/Applications/Claude.app", win32.join(appData(paths), "Claude")],
    // https://modelcontextprotocol.io/docs/develop/connect-local-servers: the file
    // is ~/Library/Application Support/Claude/claude_desktop_config.json on macOS
    // and %APPDATA%\Claude\claude_desktop_config.json on Windows, entries under
    // `mcpServers`. Linux has no Claude Desktop; Docker's registry names
    // ~/.config/claude/claude_desktop_config.json there and so does Relay.
    connect: {
      kind: "mcp-file",
      file: (paths) => byPlatform(paths, {
        darwin: posix.join(appSupport(paths), "Claude", "claude_desktop_config.json"),
        win32: win32.join(appData(paths), "Claude", "claude_desktop_config.json"),
        linux: posix.join(paths.home, ".config", "claude", "claude_desktop_config.json"),
      }),
      shape: "mcpServers",
    },
    start: { kind: "restart", instruction: "Restart Claude Desktop to load Relay, then ask it to read your Relay messages." },
    detectedAs: [],
  };

export default agent;
