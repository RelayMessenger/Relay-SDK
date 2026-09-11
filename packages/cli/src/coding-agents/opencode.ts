import type { CodingAgent } from "../coding-agents.js";
import { platformPath, configHome } from "./shared.js";

const agent: CodingAgent =
  {
    id: "opencode",
    label: "OpenCode",
    aliases: [],
    command: "opencode",
    installedIf: (paths) => [platformPath(paths.platform).join(configHome(paths), "opencode")],
    // https://opencode.ai/docs/mcp-servers/: local servers are `mcp.<name>` with
    // `type: "local"`, a `command` array, `environment` and `enabled`; the global
    // file is ~/.config/opencode/opencode.json (Docker's registry, row `opencode`).
    connect: { kind: "mcp-file", file: (paths) => platformPath(paths.platform).join(configHome(paths), "opencode", "opencode.json"), shape: "opencode" },
    start: {
      kind: "command",
      command: "opencode",
      args: [],
      prompt: "Start OpenCode with Relay now?",
    },
    detectedAs: ["opencode"],
  };

export default agent;
