import type { CodingAgent } from "../coding-agents.js";
import { claudeConfigDir } from "./shared.js";

const agent: CodingAgent =
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude", "claudecode"],
    command: "claude",
    installedIf: (paths) => [claudeConfigDir(paths.env, paths.home, paths.platform)],
    connect: { kind: "claude-plugin" },
    detectedAs: ["claude"],
  };

export default agent;
